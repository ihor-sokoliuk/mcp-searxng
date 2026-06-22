import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { parse } from "node-html-parser";
import { SearXNGWeb } from "./types.js";
import { getKnownCategories, getKnownEngines } from "./instance-info.js";
import { createProxyAgent, createDefaultAgent, ProxyType } from "./proxy.js";
import { logMessage } from "./logging.js";
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

  try {
    logMessage(mcpServer, "info", `Making request to: ${url.toString()}`);
    return await fetch(url.toString(), {
      ...requestOptions,
      signal: controller.signal,
    });
  } catch (error: any) {
    logMessage(mcpServer, "error", `Network error during search request: ${error.message}`, { query, url: url.toString() });
    const context: ErrorContext = {
      url: url.toString(),
      searxngUrl,
      proxyAgent: !!(requestOptions as any).dispatcher,
      username: process.env.AUTH_USERNAME,
    };
    throw createNetworkError(error, context);
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
  logMessage(mcpServer, "info", `Retrying search with HTML fallback: ${htmlUrl.toString()}`);

  const response = await fetchWithSearchTimeout(mcpServer, htmlUrl, requestOptions, timeoutMs, query, searxngUrl);
  if (!response.ok) {
    let responseBody: string;
    try {
      responseBody = await response.text();
    } catch {
      responseBody = '[Could not read response body]';
    }

    const context: ErrorContext = {
      url: htmlUrl.toString(),
      searxngUrl,
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
  const invalid: string[] = [];

  for (const requested of splitCommaSeparated(value)) {
    const canonical = lookup.get(requested.toLowerCase());
    if (canonical === undefined) {
      invalid.push(requested);
    } else {
      normalized.push(canonical);
    }
  }

  return {
    normalized: normalized.join(","),
    invalid,
  };
}

function formatAvailableValues(label: string, values: Set<string>): string {
  const available = [...values].sort().join(", ");
  return available === "" ? "" : ` Available ${label}: ${available}.`;
}

function createValidationError(kind: "category" | "engine", invalid: string[], available: Set<string>): MCPSearXNGError {
  const label = kind === "category" ? "categories" : "engines";
  return new MCPSearXNGError(
    `🔍 Invalid SearXNG ${kind} name(s): ${invalid.join(", ")}.` +
    formatAvailableValues(label, available) +
    ` Use the searxng_instance_info tool to discover available ${label}.`,
  );
}

export type NormalizedFilters = {
  categories?: string;
  engines?: string;
  validationWarning?: string;
  validationNote?: string;
};

export async function normalizeSearchFilters(
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

  let normalizedCategories = effectiveCategories && knownCategories
    ? normalizeCommaSeparated(effectiveCategories, knownCategories)
    : undefined;
  let normalizedEngines = effectiveEngines && knownEngines
    ? normalizeCommaSeparated(effectiveEngines, knownEngines)
    : undefined;

  if (
    (normalizedCategories && normalizedCategories.invalid.length > 0) ||
    (normalizedEngines && normalizedEngines.invalid.length > 0)
  ) {
    if (effectiveCategories) {
      knownCategories = await getKnownCategories(mcpServer, true);
      knownEngines = effectiveEngines && knownCategories !== null
        ? await getKnownEngines(mcpServer)
        : knownEngines;
    } else if (effectiveEngines) {
      knownEngines = await getKnownEngines(mcpServer, true);
    }

    if (knownCategories === null || knownEngines === null) {
      return {
        categories: effectiveCategories,
        engines: effectiveEngines,
        validationWarning: unavailableWarning,
        validationNote: unavailableNote,
      };
    }

    normalizedCategories = effectiveCategories && knownCategories
      ? normalizeCommaSeparated(effectiveCategories, knownCategories)
      : undefined;
    normalizedEngines = effectiveEngines && knownEngines
      ? normalizeCommaSeparated(effectiveEngines, knownEngines)
      : undefined;
  }

  if (normalizedCategories && normalizedCategories.invalid.length > 0 && knownCategories) {
    throw createValidationError("category", normalizedCategories.invalid, knownCategories);
  }

  if (normalizedEngines && normalizedEngines.invalid.length > 0 && knownEngines) {
    throw createValidationError("engine", normalizedEngines.invalid, knownEngines);
  }

  return {
    categories: normalizedCategories ? normalizedCategories.normalized : undefined,
    engines: normalizedEngines ? normalizedEngines.normalized : undefined,
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
  
  const searxngUrl = process.env.SEARXNG_URL!;
  const parsedUrl = new URL(searxngUrl.endsWith('/') ? searxngUrl : searxngUrl + '/');

  const url = new URL('search', parsedUrl);

  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("pageno", pageno.toString());

  if (
    time_range !== undefined &&
    ["day", "week", "month", "year"].includes(time_range)
  ) {
    url.searchParams.set("time_range", time_range);
  }

  if (effectiveLanguage && effectiveLanguage !== "all") {
    url.searchParams.set("language", effectiveLanguage);
  }

  if (effectiveSafesearch !== undefined && [0, 1, 2].includes(effectiveSafesearch)) {
    url.searchParams.set("safesearch", effectiveSafesearch.toString());
  }

  if (filters.categories) {
    url.searchParams.set("categories", filters.categories);
  }

  if (filters.engines) {
    url.searchParams.set("engines", filters.engines);
  }

  // Prepare request options with headers
  const requestOptions: RequestInit = {
    method: "GET"
  };

  // Add proxy or default dispatcher (includes system CA certs for TLS)
  const proxyAgent = createProxyAgent(url.toString(), ProxyType.SEARCH);
  const dispatcher = proxyAgent ?? createDefaultAgent();
  if (dispatcher) {
    (requestOptions as any).dispatcher = dispatcher;
  }

  // Add basic authentication if credentials are provided
  const username = process.env.AUTH_USERNAME;
  const password = process.env.AUTH_PASSWORD;

  if (username && password) {
    const base64Auth = Buffer.from(`${username}:${password}`).toString('base64');
    requestOptions.headers = {
      ...requestOptions.headers,
      'Authorization': `Basic ${base64Auth}`
    };
  }

  // Add User-Agent header if configured
  const userAgent = process.env.USER_AGENT;
  if (userAgent) {
    requestOptions.headers = {
      ...requestOptions.headers,
      'User-Agent': userAgent
    };
  }

  // Fetch with AbortController timeout and enhanced error handling
  const SEARCH_TIMEOUT_MS = parseInt(process.env.SEARXNG_TIMEOUT_MS ?? "10000", 10);

  let response: Response;
  response = await fetchWithSearchTimeout(mcpServer, url, requestOptions, SEARCH_TIMEOUT_MS, query, searxngUrl);

  let data: SearXNGWeb;

  if (!response.ok) {
    if (isHtmlFallbackEnabled() && shouldFallbackForStatus(response.status)) {
      data = await fetchHtmlFallbackSearch(mcpServer, url, requestOptions, SEARCH_TIMEOUT_MS, query, searxngUrl);
    } else {
      let responseBody: string;
      try {
        responseBody = await response.text();
      } catch {
        responseBody = '[Could not read response body]';
      }

      const context: ErrorContext = {
        url: url.toString(),
        searxngUrl
      };
      throw createServerError(response.status, response.statusText, responseBody, context);
    }
  } else {
    // Parse JSON response
    try {
      data = (await response.json()) as SearXNGWeb;
    } catch (error: any) {
      if (isHtmlFallbackEnabled()) {
        data = await fetchHtmlFallbackSearch(mcpServer, url, requestOptions, SEARCH_TIMEOUT_MS, query, searxngUrl);
      } else {
        let responseText: string;
        try {
          responseText = await response.text();
        } catch {
          responseText = '[Could not read response text]';
        }

        const context: ErrorContext = { url: url.toString() };
        throw createJSONError(responseText, context);
      }
    }
  }

  if (!data.results) {
    const context: ErrorContext = { url: url.toString(), query };
    throw createDataError(data, context);
  }

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
    }, null, 2);
  }

  const metadata = formatSearchMetadata(data);
  const leadingSections = [
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
