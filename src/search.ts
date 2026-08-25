import { McpServer } from "@modelcontextprotocol/server";
import { parse } from "node-html-parser";
import { SearXNGWeb, type ResultDetail } from "./types.js";
import { getEngineTimeRangeSupport, getKnownCategories, getKnownEngines } from "./instance-info.js";
import { applySearchRequestConfig, fetchSearxng } from "./proxy.js";
import { logMessage } from "./logging.js";
import { searchCache } from "./search-cache.js";
import { parseStrictInteger } from "./env-int.js";
import {
  cancelAuxiliaryResponseBody,
  readSearxngResponseBody,
  resolveSearxngResponseMaxBytes,
} from "./searxng-response.js";
import { sanitizeDiagnosticText } from "./diagnostic-sanitizer.js";
import {
  getHealthySearxngInstances,
  getSearxngInstances,
  isSearxngFanoutEnabled,
  recordSearxngInstanceFailure,
  recordSearxngInstanceSuccess,
  redactSearxngInstanceUrl,
  stripSearxngInstanceUrlUserinfo,
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

  const parsed = parseStrictInteger(rawValue);
  if (parsed === undefined || parsed <= 0 || parsed > 20) {
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

  const parsed = parseStrictInteger(rawValue);
  if (parsed === undefined || parsed <= 0) {
    logMessage(
      mcpServer,
      "warning",
      `Ignoring invalid SEARXNG_MAX_RESULT_CHARS="${rawValue}". Expected a positive integer.`,
    );
    return undefined;
  }

  return parsed;
}

export function getSearchTimeoutMs(mcpServer: McpServer): number {
  const rawValue = process.env.SEARXNG_TIMEOUT_MS;
  if (rawValue === undefined || rawValue.trim() === "") {
    return 10000;
  }

  // Number() (not parseInt) so unit/decimal strings like "10s" or "1.5" fall
  // back instead of silently truncating to a tiny timeout — "10s" is the exact
  // misconfiguration BUG-013 was reported against. Upper bound is the 32-bit
  // setTimeout ceiling: Node clamps a larger delay to 1 ms, which would again
  // abort almost immediately.
  const parsed = Number(rawValue.trim());
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 2_147_483_647) {
    logMessage(
      mcpServer,
      "warning",
      `Ignoring invalid SEARXNG_TIMEOUT_MS="${rawValue}". Expected a positive integer up to 2147483647. Using default 10000.`,
    );
    return 10000;
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

function getSearchDiagnosticUrl(redactedUrl: string): string {
  try {
    const diagnosticUrl = new URL(redactedUrl);
    diagnosticUrl.search = "";
    diagnosticUrl.hash = "";
    return diagnosticUrl.toString();
  } catch {
    // redactSearxngInstanceUrl already removes userinfo. Retain that safe value
    // while stripping any query or fragment if URL construction ever fails.
    return redactedUrl.split(/[?#]/u, 1)[0];
  }
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

async function fetchWithSearchTimeout<T>(
  mcpServer: McpServer,
  url: URL,
  requestOptions: RequestInit,
  timeoutMs: number,
  searxngUrl: string,
  handleResponse: (response: Response) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const rawUrl = url.toString();
  const redactedUrl = redactSearxngInstanceUrl(rawUrl);
  let diagnosticUrl = redactedUrl;

  try {
    diagnosticUrl = getSearchDiagnosticUrl(redactedUrl);
    logMessage(mcpServer, "info", `Making request to: ${redactedUrl}`);
    const response = await fetchSearxng(rawUrl, {
      ...requestOptions,
      signal: controller.signal,
    });
    return await handleResponse(response);
  } catch (error: any) {
    if (error instanceof MCPSearXNGError) {
      throw error;
    }
    const safeMessage = typeof error?.message === "string"
      ? error.message.replaceAll(rawUrl, diagnosticUrl)
      : error?.message;
    const safeError = new Error(safeMessage);
    (safeError as any).code = error?.code;
    (safeError as any).cause = error?.cause;
    logMessage(mcpServer, "error", `Network error during search request: ${safeMessage}`, {
      url: diagnosticUrl,
    });
    const context: ErrorContext = {
      url: redactedUrl,
      searxngUrl: redactSearxngInstanceUrl(searxngUrl),
      proxyAgent: !!(requestOptions as any).dispatcher,
    };
    throw createNetworkError(safeError, context);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function throwBoundedServerError(
  response: Response,
  maxResponseBytes: number,
  context: ErrorContext,
): Promise<never> {
  let responseBody = "[Could not read response body]";
  let truncated = false;
  try {
    const preview = await readSearxngResponseBody(response, maxResponseBytes, { preview: true });
    responseBody = sanitizeDiagnosticText(preview.text);
    truncated = preview.truncated;
  } catch {
    // The status remains more useful than an unavailable diagnostic preview.
  }

  const serverError = createServerError(response.status, response.statusText, responseBody, context);
  if (truncated) {
    serverError.message += " [Response body truncated]";
  }
  throw serverError;
}

async function fetchHtmlFallbackSearch(
  mcpServer: McpServer,
  jsonUrl: URL,
  requestOptions: RequestInit,
  timeoutMs: number,
  query: string,
  searxngUrl: string,
  maxResponseBytes: number,
): Promise<SearXNGWeb> {
  const htmlUrl = buildHtmlFallbackUrl(jsonUrl);
  logMessage(mcpServer, "info", `Retrying search with HTML fallback: ${redactSearxngInstanceUrl(htmlUrl.toString())}`);

  return fetchWithSearchTimeout(
    mcpServer,
    htmlUrl,
    requestOptions,
    timeoutMs,
    searxngUrl,
    async (response) => {
      const context: ErrorContext = {
        url: redactSearxngInstanceUrl(htmlUrl.toString()),
        searxngUrl: redactSearxngInstanceUrl(searxngUrl),
      };
      if (!response.ok) {
        return throwBoundedServerError(response, maxResponseBytes, context);
      }
      const { text } = await readSearxngResponseBody(response, maxResponseBytes);
      return parseHtmlSearchResults(text, query);
    },
  );
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
  maxResponseBytes: number;
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

type ResponseFormat = "text" | "json";
const warnedInvalidDefaultResponseFormat = new WeakSet<McpServer>();

async function validateTimeRangeSupport(
  mcpServer: McpServer,
  engines: string | undefined,
  timeRange: string | undefined,
): Promise<void> {
  if (!engines || !timeRange) {
    return;
  }

  const requestedEngines = splitCommaSeparated(engines);
  const support = await getEngineTimeRangeSupport(mcpServer, requestedEngines);
  if (support === null) {
    throw new MCPSearXNGError(
      `Cannot verify whether the selected engines support time_range=${timeRange} because SearXNG /config is unavailable. ` +
      "Retry after capability discovery is available, or omit time_range."
    );
  }

  const incompatible = [...support.unsupported, ...support.unknown];
  if (incompatible.length > 0) {
    throw new MCPSearXNGError(
      `The selected ${incompatible.length === 1 ? "engine does" : "engines do"} not confirm support for ` +
      `time_range=${timeRange}: ${incompatible.join(", ")}. SearXNG skips incompatible engines and can return a misleading empty result. ` +
      "Omit time_range or use an engine-specific query filter; this adapter will not silently change the requested filter."
    );
  }
}

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

function getDefaultResponseFormat(mcpServer: McpServer): ResponseFormat {
  const rawValue = process.env.SEARXNG_DEFAULT_RESPONSE_FORMAT;
  if (rawValue === undefined || rawValue.trim() === "") {
    return "text";
  }

  const value = rawValue.trim();
  if (value === "text" || value === "json") {
    return value;
  }

  if (!warnedInvalidDefaultResponseFormat.has(mcpServer)) {
    warnedInvalidDefaultResponseFormat.add(mcpServer);
    logMessage(
      mcpServer,
      "warning",
      "Ignoring invalid SEARXNG_DEFAULT_RESPONSE_FORMAT. Expected text or json. Using text.",
    );
  }

  return "text";
}

function getDefaultSafesearch(mcpServer: McpServer): number | undefined {
  const rawValue = process.env.SEARXNG_DEFAULT_SAFESEARCH;
  if (rawValue === undefined || rawValue.trim() === "") {
    return undefined;
  }

  const parsed = parseStrictInteger(rawValue);
  if (parsed === undefined || ![0, 1, 2].includes(parsed)) {
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

export function formatCachedSearchResult(result: string, responseFormat: "text" | "json", resultDetail: ResultDetail = "full"): string {
  if (resultDetail === "compact") {
    return result;
  }
  if (responseFormat === "json") {
    try {
      return JSON.stringify({
        ...JSON.parse(result),
        cached: true,
      }, null, 2);
    } catch {
      // A cache hit must never turn a previously successful call into a hard
      // failure. Stored JSON is always valid in practice (only successful JSON
      // responses are cached under a JSON key), but set() is public, so if the
      // stored value somehow isn't valid JSON, serve it unannotated.
      return result;
    }
  }

  return `${result}\n\n_Cached result_`;
}

function asSafeString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asTextLineString(value: unknown): string {
  return asSafeString(value).replace(/[\r\n\u2028\u2029]+/gu, " ");
}

function truncateSearchResults(results: SearXNGWeb["results"], maxResultChars?: number): SearXNGWeb["results"] {
  if (maxResultChars === undefined) {
    return results;
  }
  return results.map((result) => {
    const cloned = { ...result };
    if (typeof result.content === "string") {
      cloned.content = truncateResultContent(result.content, maxResultChars);
    }
    return cloned;
  });
}

function formatCompactTextResults(results: SearXNGWeb["results"], maxResultChars?: number): string {
  return results.map((result) => [
    `Title: ${asTextLineString(result.title)}`,
    `Description: ${truncateResultContent(asTextLineString(result.content), maxResultChars)}`,
    `URL: ${asTextLineString(result.url)}`,
  ].join("\n")).join("\n\n");
}

function compactJsonResults(results: SearXNGWeb["results"], maxResultChars?: number) {
  return results.map((result) => ({
    title: asSafeString(result.title),
    url: asSafeString(result.url),
    content: truncateResultContent(asSafeString(result.content), maxResultChars),
  }));
}

async function fetchSearchFromInstance(
  mcpServer: McpServer,
  instanceUrl: string,
  request: SearchRequest,
): Promise<InstanceSearchResult> {
  const url = buildSearchUrl(instanceUrl, request);
  const requestOptions = buildSearchRequestOptions(url);
  const requestUrl = stripSearxngInstanceUrlUserinfo(url);
  return fetchWithSearchTimeout(
    mcpServer,
    requestUrl,
    requestOptions,
    request.timeoutMs,
    instanceUrl,
    async (response) => {
      let data: SearXNGWeb;

      if (!response.ok) {
        if (isHtmlFallbackEnabled() && shouldFallbackForStatus(response.status)) {
          await cancelAuxiliaryResponseBody(response);
          data = await fetchHtmlFallbackSearch(
            mcpServer,
            requestUrl,
            requestOptions,
            request.timeoutMs,
            request.query,
            instanceUrl,
            request.maxResponseBytes,
          );
        } else {
          return throwBoundedServerError(response, request.maxResponseBytes, {
            url: redactSearxngInstanceUrl(url.toString()),
            searxngUrl: redactSearxngInstanceUrl(instanceUrl),
          });
        }
      } else {
        const { text } = await readSearxngResponseBody(response, request.maxResponseBytes);
        try {
          data = JSON.parse(text) as SearXNGWeb;
        } catch {
          if (isHtmlFallbackEnabled()) {
            data = await fetchHtmlFallbackSearch(
              mcpServer,
              requestUrl,
              requestOptions,
              request.timeoutMs,
              request.query,
              instanceUrl,
              request.maxResponseBytes,
            );
          } else {
            throw createJSONError(sanitizeDiagnosticText(text));
          }
        }
      }

      if (!data.results) {
        throw createDataError();
      }

      return { instanceUrl, data };
    },
  );
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
  response_format?: ResponseFormat,
  result_detail: ResultDetail = "full",
) {
  const startTime = Date.now();
  const effectiveResponseFormat = response_format ?? getDefaultResponseFormat(mcpServer);
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
  await validateTimeRangeSupport(mcpServer, filters.engines, time_range);

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

  const SEARCH_TIMEOUT_MS = getSearchTimeoutMs(mcpServer);
  const responseMaxBytes = resolveSearxngResponseMaxBytes(mcpServer);
  const instances = getSearxngInstances();
  const fanoutEnabled = isSearxngFanoutEnabled();
  const includeProvenance = instances.length > 1;
  const request: SearchRequest = {
    query,
    pageno,
    time_range,
    effectiveLanguage,
    effectiveSafesearch,
    filters,
    timeoutMs: SEARCH_TIMEOUT_MS,
    maxResponseBytes: responseMaxBytes,
  };
  const cacheArgs: Record<string, unknown> = {
    query,
    pageno,
    time_range,
    effectiveLanguage,
    effectiveSafesearch,
    filters,
    min_score,
    effectiveMax,
    maxResultChars,
    response_format: effectiveResponseFormat,
    result_detail,
    instances,
    searxngFanout: fanoutEnabled,
  };
  const cachedResult = searchCache.get("searxng_web_search", cacheArgs);
  if (cachedResult !== null) {
    return formatCachedSearchResult(cachedResult, effectiveResponseFormat, result_detail);
  }

  let data: SearXNGWeb;
  let servedBy: string[] = [];

  if (instances.length === 1) {
    const result = await fetchSearchFromInstance(mcpServer, instances[0], request);
    data = result.data;
  } else {
    const multiResult = fanoutEnabled
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

  if (effectiveResponseFormat === "json") {
    const result = result_detail === "compact"
      ? JSON.stringify({ results: compactJsonResults(slicedResults, maxResultChars) }, null, 2)
      : JSON.stringify({
        ...data,
        results: truncateSearchResults(slicedResults, maxResultChars),
        ...(filters.validationWarning ? { warnings: [filters.validationWarning] } : {}),
        ...(includeProvenance ? { servedBy: redactedServedBy } : {}),
      }, null, 2);
    if (slicedResults.length > 0) {
      searchCache.set("searxng_web_search", cacheArgs, result);
    }
    return result;
  }

  const metadata = result_detail === "full" ? formatSearchMetadata(data) : "";
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
    const result = result_detail === "compact" ? noResultsMessage : (leadingSections ? `${leadingSections}\n\n---\n\n${noResultsMessage}` : noResultsMessage);
    return result;
  }

  const duration = Date.now() - startTime;
  logMessage(mcpServer, "info", `Search completed: "${query}" (${searchParams}) - ${slicedResults.length} results in ${duration}ms`);

  const formattedResults = result_detail === "compact"
    ? formatCompactTextResults(slicedResults, maxResultChars)
    : slicedResults
    .map((r) => {
      const lines = [
        `Title: ${asTextLineString(r.title)}`,
        `Description: ${truncateResultContent(asTextLineString(r.content), maxResultChars)}`,
        `URL: ${asTextLineString(r.url)}`,
      ];

      if (typeof r.score === "number" && Number.isFinite(r.score)) {
        lines.push(`Relevance Score: ${r.score.toFixed(3)}`);
      }

      const engines = Array.isArray(r.engines) && r.engines.every((engine) => typeof engine === "string")
        ? r.engines.map((engine) => asTextLineString(engine).trim()).filter(Boolean)
        : [];
      if (engines.length > 0) {
        lines.push(`Engines: ${engines.join(", ")}`);
      }
      const category = asTextLineString(r.category).trim();
      const publishedDate = asTextLineString(r.publishedDate).trim();
      const thumbnail = asTextLineString(r.thumbnail).trim();
      const imageSource = asTextLineString(r.img_src).trim();
      if (category) lines.push(`Category: ${category}`);
      if (publishedDate) lines.push(`Published Date: ${publishedDate}`);
      if (thumbnail) lines.push(`Thumbnail: ${thumbnail}`);
      if (imageSource) lines.push(`Image Source: ${imageSource}`);

      return lines.join("\n");
    })
    .join("\n\n");

  const result = result_detail === "compact" ? formattedResults : (leadingSections ? `${leadingSections}\n\n---\n\n${formattedResults}` : formattedResults);
  searchCache.set("searxng_web_search", cacheArgs, result);
  return result;
}
