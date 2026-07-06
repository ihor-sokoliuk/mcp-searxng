import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { parse } from "node-html-parser";
import { SearXNGWeb } from "./types.js";
import { getKnownCategories, getKnownEngines } from "./instance-info.js";
import { applySearchRequestConfig } from "./proxy.js";
import { logMessage } from "./logging.js";
import {
  getHealthySearxngInstances,
  getSearxngInstances,
  isSearxngFanoutEnabled,
  recordSearxngInstanceFailure,
  recordSearxngInstanceSuccess,
  redactSearxngInstanceUrl,
} from "./searxng-instances.js";
import {
  MCPSearXNGError,
  validateEnvironment,
  createNetworkError,
  createServerError,
  createJSONError,
  createDataError,
  createNoResultsMessage,
  type ErrorContext
} from "./error-handler.js";

function getOperatorMaxResults(mcpServer: McpServer): number | undefined {
  const rawValue = process.env.SEARXNG_MAX_RESULTS;
  if (rawValue === undefined || rawValue.trim() === "") {
    return undefined;
  }

  const parsed = parseInt(rawValue, 10);
  if (Number.isNaN(parsed) || parsed <= 0 || parsed > 20) {
    logMessage(
      mcpServer,
      "warning",
      `Ignoring invalid SEARXNG_MAX_RESULTS="${rawValue}". Expected an integer from 1 to 20.`,
    );
    return undefined;
  }

  return parsed;
}

function getMaxResultChars(mcpServer: McpServer): number | undefined {
  const rawValue = process.env.SEARXNG_MAX_RESULT_CHARS;
  if (rawValue === undefined || rawValue.trim() === "") {
    return undefined;
  }

  const parsed = parseInt(rawValue, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    logMessage(
      mcpServer,
      "warning",
      `Ignoring invalid SEARXNG_MAX_RESULT_CHARS="${rawValue}". Expected a positive integer.`,
    );
    return undefined;
  }

  return parsed;
}

function truncateResultContent(content: string, maxResultChars?: number): string {
  if (maxResultChars === undefined || content.length <= maxResultChars) {
    return content;
  }

  return `${content.slice(0, maxResultChars)}…`;
}

function normalizeHtmlText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function isHtmlFallbackEnabled(): boolean {
  return process.env.SEARXNG_HTML_FALLBACK === "true";
}

function shouldFallbackForStatus(status: number): boolean {
  return status === 403 || status === 404;
}

function buildHtmlFallbackUrl(jsonUrl: URL): URL {
  const htmlUrl = new URL(jsonUrl.toString());
  htmlUrl.searchParams.delete("format");
  return htmlUrl;
}

function parseHtmlSearchResults(html: string, query: string): SearXNGWeb {
  const root = parse(html);
  const articles = root.querySelectorAll("article.result");
  const candidates = articles.length > 0 ? articles : root.querySelectorAll(".result");
  const results = candidates
    .map((entry) => {
      const link = entry.querySelector("h3 > a") ?? entry.querySelector("h3 a") ?? entry.querySelector("a[href]");
      if (!link) {
        return undefined;
      }

      const href = link?.getAttribute("href")?.trim();

      if (!href) {
        return undefined;
      }

      try {
        new URL(href);
      } catch {
        return undefined;
      }

      const title = normalizeHtmlText(link.text);
      const snippetNode = entry.querySelector("p.content") ?? entry.querySelector(".content");
      const content = snippetNode ? normalizeHtmlText(snippetNode.text) : "";

      return {
        title,
        url: href,
        content,
      };
    })
    .filter((result): result is { title: string; url: string; content: string } => result !== undefined);

  return {
    query,
    number_of_results: results.length,
    results,
    sourceFormat: "html",
  };
}

async function fetchWithSearchTimeout(
  mcpServer: McpServer,
  url: URL,
  requestOptions: RequestInit,
  timeoutMs: number,
  query: string,
  searxngUrl: string,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const rawUrl = url.toString();
  const redactedUrl = redactSearxngInstanceUrl(rawUrl);

  try {
    logMessage(mcpServer, "info", `Making request to: ${redactedUrl}`);
    return await fetch(rawUrl, {
      ...requestOptions,
      signal: controller.signal,
    });
  } catch (error: any) {
    const safeMessage = typeof error?.message === "string"
      ? error.message.replaceAll(rawUrl, redactedUrl)
      : error?.message;
    const safeError = new Error(safeMessage);
    (safeError as any).code = error?.code;
    (safeError as any).cause = error?.cause;
    logMessage(mcpServer, "error", `Network error during search request: ${safeMessage}`, { query, url: redactedUrl });
    const context: ErrorContext = {
      url: redactedUrl,
      searxngUrl: redactSearxngInstanceUrl(searxngUrl),
      proxyAgent: !!(requestOptions as any).dispatcher,
      username: process.env.AUTH_USERNAME,
    };
    throw createNetworkError(safeError, context);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchHtmlFallbackSearch(
  mcpServer: McpServer,
  jsonUrl: URL,
  requestOptions: RequestInit,
  timeoutMs: number,
  query: string,
  searxngUrl: string,
): Promise<SearXNGWeb> {
  const htmlUrl = buildHtmlFallbackUrl(jsonUrl);
  logMessage(mcpServer, "info", `Retrying search with HTML fallback: ${redactSearxngInstanceUrl(htmlUrl.toString())}`);

  const response = await fetchWithSearchTimeout(mcpServer, htmlUrl, requestOptions, timeoutMs, query, searxngUrl);
  if (!response.ok) {
    let responseBody: string;
    try {
      responseBody = await response.text();
    } catch {
      responseBody = '[Could not read response body]';
    }

    const context: ErrorContext = {
      url: redactSearxngInstanceUrl(htmlUrl.toString()),
      searxngUrl: redactSearxngInstanceUrl(searxngUrl),
    };
    throw createServerError(response.status, response.statusText, responseBody, context);
  }

  const html = await response.text();
  return parseHtmlSearchResults(html, query);
}

function hasItems<T>(items: T[] | undefined): items is T[] {
  return Array.isArray(items) && items.length > 0;
}

function splitCommaSeparated(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

function buildCanonicalLookup(knownValues: Set<string>): Map<string, string> {
  const lookup = new Map<string, string>();

  for (const value of knownValues) {
    lookup.set(value.trim().toLowerCase(), value);
  }

  return lookup;
}

function normalizeCommaSeparated(value: string, knownValues: Set<string>) {
  const lookup = buildCanonicalLookup(knownValues);
  const normalized: string[] = [];

  for (const requested of splitCommaSeparated(value)) {
    const canonical = lookup.get(requested.toLowerCase());
    if (canonical === undefined) {
      normalized.push(requested);
    } else {
      normalized.push(canonical);
    }
  }

  return normalized.join(",");
}

type NormalizedFilters = {
  categories?: string;
  engines?: string;
  validationWarning?: string;
  validationNote?: string;
};

type SearchRequest = {
  query: string;
  pageno: number;
  time_range?: string;
  effectiveLanguage: string;
  effectiveSafesearch?: number;
  filters: NormalizedFilters;
  timeoutMs: number;
};

type InstanceSearchResult = {
  instanceUrl: string;
  data: SearXNGWeb;
};

type MultiInstanceSearchResult = {
  data: SearXNGWeb;
  servedBy: string[];
};

type FailedInstanceResult = {
  instanceUrl: string;
  error: unknown;
};

async function normalizeSearchFilters(
  mcpServer: McpServer,
  categories?: string,
  engines?: string,
): Promise<NormalizedFilters> {
  const effectiveCategories = categories !== undefined && categories.trim() !== "" ? categories : undefined;
  const effectiveEngines = engines !== undefined && engines.trim() !== "" ? engines : undefined;

  if (!effectiveCategories && !effectiveEngines) {
    return {};
  }

  const unavailableFilterLabel = effectiveCategories && effectiveEngines
    ? "categories and engines"
    : effectiveCategories
      ? "categories"
      : "engines";
  const unavailableWarning = `${unavailableFilterLabel[0].toUpperCase()}${unavailableFilterLabel.slice(1)} were not validated or normalized because SearXNG /config is unavailable.`;
  const unavailableNote = `Note: ${unavailableFilterLabel} were not validated or normalized (SearXNG /config unavailable).`;

  let knownCategories: Set<string> | null | undefined;
  let knownEngines: Set<string> | null | undefined;

  if (effectiveCategories) {
    knownCategories = await getKnownCategories(mcpServer);
    if (knownCategories === null) {
      return {
        categories: effectiveCategories,
        engines: effectiveEngines,
        validationWarning: unavailableWarning,
        validationNote: unavailableNote,
      };
    }
  }

  if (effectiveEngines) {
    knownEngines = await getKnownEngines(mcpServer);
    if (knownEngines === null) {
      return {
        categories: effectiveCategories,
        engines: effectiveEngines,
        validationWarning: unavailableWarning,
        validationNote: unavailableNote,
      };
    }
  }

  const normalizedCategories = effectiveCategories && knownCategories
    ? normalizeCommaSeparated(effectiveCategories, knownCategories)
    : undefined;
  const normalizedEngines = effectiveEngines && knownEngines
    ? normalizeCommaSeparated(effectiveEngines, knownEngines)
    : undefined;

  return {
    categories: normalizedCategories,
    engines: normalizedEngines,
  };
}

function formatSearchMetadata(data: SearXNGWeb): string {
  const sections: string[] = [];

  if (hasItems(data.answers)) {
    sections.push(data.answers.map((answer) => `Direct answer: ${answer}`).join("\n"));
  }

  if (hasItems(data.corrections)) {
    sections.push(data.corrections.map((correction) => `Spelling correction: did you mean "${correction}"?`).join("\n"));
  }

  if (hasItems(data.suggestions)) {
    sections.push(`Suggestions: ${data.suggestions.join(", ")}`);
  }

  if (hasItems(data.infoboxes)) {
    const infoboxText = data.infoboxes
      .map((infobox) => {
        const lines = [`Infobox: ${infobox.infobox}`];
        if (infobox.content) {
          lines.push(infobox.content);
        }
        if (hasItems(infobox.urls)) {
          lines.push(...infobox.urls.map((entry) => `${entry.title}: ${entry.url}`));
        }
        return lines.join("\n");
      })
      .join("\n\n");
    sections.push(infoboxText);
  }

  return sections.join("\n\n");
}

function getDefaultLanguage(): string {
  return process.env.SEARXNG_DEFAULT_LANGUAGE ?? "all";
}

function getDefaultSafesearch(mcpServer: McpServer): number | undefined {
  const rawValue = process.env.SEARXNG_DEFAULT_SAFESEARCH;
  if (rawValue === undefined || rawValue.trim() === "") {
    return undefined;
  }

  const parsed = parseInt(rawValue, 10);
  if (Number.isNaN(parsed) || ![0, 1, 2].includes(parsed)) {
    logMessage(
      mcpServer,
      "warning",
      `Ignoring invalid SEARXNG_DEFAULT_SAFESEARCH="${rawValue}". Expected 0, 1, or 2.`,
    );
    return undefined;
  }

  return parsed;
}

function normalizeTimeRangeParam(value: string | undefined): string | undefined {
  return value !== undefined && ["day", "week", "month", "year"].includes(value)
    ? value
    : undefined;
}

function normalizeLanguageParam(value: string | undefined): string | undefined {
  return value && value !== "all" ? value : undefined;
}

function normalizeSafesearchParam(value: number | undefined): string | undefined {
  return value !== undefined && [0, 1, 2].includes(value) ? value.toString() : undefined;
}

function normalizeTruthyParam(value: string | undefined): string | undefined {
  return value || undefined;
}

function buildSearchUrl(instanceUrl: string, request: SearchRequest): URL {
  const parsedUrl = new URL(instanceUrl.endsWith('/') ? instanceUrl : instanceUrl + '/');
  const url = new URL('search', parsedUrl);
  const params: Array<[string, string | undefined]> = [
    ["q", request.query],
    ["format", "json"],
    ["pageno", request.pageno.toString()],
    ["time_range", normalizeTimeRangeParam(request.time_range)],
    ["language", normalizeLanguageParam(request.effectiveLanguage)],
    ["safesearch", normalizeSafesearchParam(request.effectiveSafesearch)],
    ["categories", normalizeTruthyParam(request.filters.categories)],
    ["engines", normalizeTruthyParam(request.filters.engines)],
  ];

  for (const [name, value] of params) {
    if (value !== undefined) {
      url.searchParams.set(name, value);
    }
  }

  return url;
}

function buildSearchRequestOptions(url: URL): RequestInit {
  const requestOptions: RequestInit = {
    method: "GET"
  };

  applySearchRequestConfig(requestOptions, url.toString());

  return requestOptions;
}

async function fetchSearchFromInstance(
  mcpServer: McpServer,
  instanceUrl: string,
  request: SearchRequest,
): Promise<InstanceSearchResult> {
  const url = buildSearchUrl(instanceUrl, request);
  const requestOptions = buildSearchRequestOptions(url);
  const response = await fetchWithSearchTimeout(mcpServer, url, requestOptions, request.timeoutMs, request.query, instanceUrl);

  let data: SearXNGWeb;

  if (!response.ok) {
    if (isHtmlFallbackEnabled() && shouldFallbackForStatus(response.status)) {
      data = await fetchHtmlFallbackSearch(mcpServer, url, requestOptions, request.timeoutMs, request.query, instanceUrl);
    } else {
      let responseBody: string;
      try {
        responseBody = await response.text();
      } catch {
        responseBody = '[Could not read response body]';
      }

      const context: ErrorContext = {
        url: redactSearxngInstanceUrl(url.toString()),
        searxngUrl: redactSearxngInstanceUrl(instanceUrl)
      };
      throw createServerError(response.status, response.statusText, responseBody, context);
    }
  } else {
    // Read the body as text once, then parse — a Response body is single-use, so
    // calling response.text() after response.json() consumed it always throws and
    // would leave the error preview empty.
    let responseText: string;
    try {
      responseText = await response.text();
    } catch {
      responseText = '[Could not read response text]';
    }

    try {
      data = JSON.parse(responseText) as SearXNGWeb;
    } catch {
      if (isHtmlFallbackEnabled()) {
        data = await fetchHtmlFallbackSearch(mcpServer, url, requestOptions, request.timeoutMs, request.query, instanceUrl);
      } else {
        throw createJSONError(responseText);
      }
    }
  }

  if (!data.results) {
    throw createDataError();
  }

  return {
    instanceUrl,
    data,
  };
}

function hasSearchResults(data: SearXNGWeb): boolean {
  return data.results.length > 0;
}

function createAllInstancesFailedError(failures: FailedInstanceResult[], skippedInstances: string[]): MCPSearXNGError {
  if (failures.length === 0 && skippedInstances.length > 0) {
    return new MCPSearXNGError(
      `All configured SearXNG instances are in cooldown after repeated failures: ${skippedInstances.map(redactSearxngInstanceUrl).join(", ")}.`
    );
  }

  const failureDetails = failures
    .map(({ instanceUrl, error }) => `${redactSearxngInstanceUrl(instanceUrl)}: ${error instanceof Error ? error.message : String(error)}`)
    .join("; ");
  const skippedDetails = skippedInstances.length > 0
    ? ` Skipped cooled-down instances: ${skippedInstances.map(redactSearxngInstanceUrl).join(", ")}.`
    : "";

  return new MCPSearXNGError(`All configured SearXNG instances failed. ${failureDetails}${skippedDetails}`);
}

async function performFailoverSearch(
  mcpServer: McpServer,
  instances: string[],
  request: SearchRequest,
): Promise<MultiInstanceSearchResult> {
  const healthyInstances = getHealthySearxngInstances(instances);
  const healthySet = new Set(healthyInstances);
  const skippedInstances = instances.filter((instanceUrl) => !healthySet.has(instanceUrl));
  const failures: FailedInstanceResult[] = [];
  const emptyResults: InstanceSearchResult[] = [];

  for (const instanceUrl of healthyInstances) {
    try {
      const result = await fetchSearchFromInstance(mcpServer, instanceUrl, request);
      recordSearxngInstanceSuccess(instanceUrl);

      if (hasSearchResults(result.data)) {
        return {
          data: result.data,
          servedBy: [instanceUrl],
        };
      }

      emptyResults.push(result);
    } catch (error) {
      recordSearxngInstanceFailure(instanceUrl);
      failures.push({ instanceUrl, error });
    }
  }

  if (emptyResults.length > 0) {
    return {
      data: emptyResults[0].data,
      servedBy: emptyResults.map((result) => result.instanceUrl),
    };
  }

  throw createAllInstancesFailedError(failures, skippedInstances);
}

function canonicalResultUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();
    url.hash = "";
    return url.toString();
  } catch {
    return rawUrl;
  }
}

function resultScore(result: { score?: number }): number {
  return result.score ?? 0;
}

function mergeFanoutResults(results: InstanceSearchResult[]): SearXNGWeb {
  const firstContributor = results.find((result) => hasSearchResults(result.data));
  const base = firstContributor?.data ?? results[0].data;
  const byUrl = new Map<string, SearXNGWeb["results"][number]>();

  for (const result of results) {
    for (const entry of result.data.results) {
      const key = canonicalResultUrl(entry.url);
      const existing = byUrl.get(key);
      if (!existing || resultScore(entry) > resultScore(existing)) {
        byUrl.set(key, entry);
      }
    }
  }

  const mergedResults = [...byUrl.values()].sort((a, b) => resultScore(b) - resultScore(a));

  return {
    ...base,
    number_of_results: mergedResults.length,
    results: mergedResults,
  };
}

async function performFanoutSearch(
  mcpServer: McpServer,
  instances: string[],
  request: SearchRequest,
): Promise<MultiInstanceSearchResult> {
  const healthyInstances = getHealthySearxngInstances(instances);
  const healthySet = new Set(healthyInstances);
  const skippedInstances = instances.filter((instanceUrl) => !healthySet.has(instanceUrl));
  const settledResults = await Promise.all(healthyInstances.map(async (instanceUrl) => {
    try {
      const result = await fetchSearchFromInstance(mcpServer, instanceUrl, request);
      recordSearxngInstanceSuccess(instanceUrl);
      return { ok: true as const, result };
    } catch (error) {
      recordSearxngInstanceFailure(instanceUrl);
      return { ok: false as const, failure: { instanceUrl, error } };
    }
  }));

  const successes = settledResults
    .filter((entry): entry is { ok: true; result: InstanceSearchResult } => entry.ok)
    .map((entry) => entry.result);
  const failures = settledResults
    .filter((entry): entry is { ok: false; failure: FailedInstanceResult } => !entry.ok)
    .map((entry) => entry.failure);

  if (successes.length === 0) {
    throw createAllInstancesFailedError(failures, skippedInstances);
  }

  const contributing = successes.filter((result) => hasSearchResults(result.data));
  if (contributing.length === 0) {
    return {
      data: successes[0].data,
      servedBy: successes.map((result) => result.instanceUrl),
    };
  }

  return {
    data: mergeFanoutResults(contributing),
    servedBy: contributing.map((result) => result.instanceUrl),
  };
}

export async function performWebSearch(
  mcpServer: McpServer,
  query: string,
  pageno: number = 1,
  time_range?: string,
  language?: string,
  safesearch?: number,
  min_score?: number,
  num_results?: number,
  categories?: string,
  engines?: string,
  response_format: "text" | "json" = "text",
) {
  const startTime = Date.now();
  const operatorMax = getOperatorMaxResults(mcpServer);
  const effectiveMax = operatorMax !== undefined
    ? (num_results !== undefined ? Math.min(num_results, operatorMax) : operatorMax)
    : num_results;
  const maxResultChars = getMaxResultChars(mcpServer);

  const effectiveLanguage = language ?? getDefaultLanguage();
  const effectiveSafesearch = safesearch !== undefined ? safesearch : getDefaultSafesearch(mcpServer);

  const validationError = validateEnvironment();
  if (validationError) {
    logMessage(mcpServer, "error", "Configuration invalid");
    throw new MCPSearXNGError(validationError);
  }

  const filters = await normalizeSearchFilters(mcpServer, categories, engines);

  // Build detailed log message with all parameters
  const searchParams = [
    `page ${pageno}`,
    `lang: ${effectiveLanguage}`,
    time_range ? `time: ${time_range}` : null,
    effectiveSafesearch !== undefined ? `safesearch: ${effectiveSafesearch}` : null,
    min_score !== undefined ? `min_score: ${min_score}` : null,
    effectiveMax !== undefined ? `num_results: ${effectiveMax}` : null,
    filters.categories ? `categories: ${filters.categories}` : null,
    filters.engines ? `engines: ${filters.engines}` : null,
  ].filter(Boolean).join(", ");
  
  logMessage(mcpServer, "info", `Starting web search: "${query}" (${searchParams})`);

  const SEARCH_TIMEOUT_MS = parseInt(process.env.SEARXNG_TIMEOUT_MS ?? "10000", 10);
  const instances = getSearxngInstances();
  const includeProvenance = instances.length > 1;
  const request: SearchRequest = {
    query,
    pageno,
    time_range,
    effectiveLanguage,
    effectiveSafesearch,
    filters,
    timeoutMs: SEARCH_TIMEOUT_MS,
  };

  let data: SearXNGWeb;
  let servedBy: string[] = [];

  if (instances.length === 1) {
    const result = await fetchSearchFromInstance(mcpServer, instances[0], request);
    data = result.data;
  } else {
    const multiResult = isSearxngFanoutEnabled()
      ? await performFanoutSearch(mcpServer, instances, request)
      : await performFailoverSearch(mcpServer, instances, request);
    data = multiResult.data;
    servedBy = multiResult.servedBy;
  }
  const redactedServedBy = servedBy.map(redactSearxngInstanceUrl);

  const results = data.results
    .filter((result) => min_score === undefined || (result.score || 0) >= min_score);
  const slicedResults = effectiveMax !== undefined
    ? results.slice(0, effectiveMax)
    : results;

  if (response_format === "json") {
    return JSON.stringify({
      ...data,
      results: slicedResults,
      ...(filters.validationWarning ? { warnings: [filters.validationWarning] } : {}),
      ...(includeProvenance ? { servedBy: redactedServedBy } : {}),
    }, null, 2);
  }

  const metadata = formatSearchMetadata(data);
  const leadingSections = [
    includeProvenance
      ? `Served by SearXNG ${redactedServedBy.length === 1 ? "instance" : "instances"}: ${redactedServedBy.join(", ")}`
      : null,
    filters.validationNote ?? null,
    data.sourceFormat === "html" ? "Note: Results parsed from SearXNG HTML fallback; metadata is limited." : null,
    metadata || null,
  ].filter(Boolean).join("\n\n");

  if (slicedResults.length === 0) {
    const appliedFilters = [
      min_score === undefined ? null : `min_score=${min_score}`,
      effectiveMax === undefined ? null : `num_results=${effectiveMax}`,
    ].filter(Boolean).join(" ");
    const filterNote = appliedFilters ? ` after applying ${appliedFilters}` : "";
    logMessage(mcpServer, "info", `No results found for query: "${query}"${filterNote}`);
    const noResultsMessage = createNoResultsMessage(query);
    return leadingSections ? `${leadingSections}\n\n---\n\n${noResultsMessage}` : noResultsMessage;
  }

  const duration = Date.now() - startTime;
  logMessage(mcpServer, "info", `Search completed: "${query}" (${searchParams}) - ${slicedResults.length} results in ${duration}ms`);

  const formattedResults = slicedResults
    .map((r) => {
      const lines = [
        `Title: ${r.title || ""}`,
        `Description: ${truncateResultContent(r.content || "", maxResultChars)}`,
        `URL: ${r.url || ""}`,
      ];

      if (r.score !== undefined) {
        lines.push(`Relevance Score: ${r.score.toFixed(3)}`);
      }

      return lines.join("\n");
    })
    .join("\n\n");

  return leadingSections ? `${leadingSections}\n\n---\n\n${formattedResults}` : formattedResults;
}
