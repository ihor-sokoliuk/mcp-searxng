import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SearXNGWeb } from "./types.js";
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

function hasItems<T>(items: T[] | undefined): items is T[] {
  return Array.isArray(items) && items.length > 0;
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

  if (hasItems(data.unresponsive_engines)) {
    const engines = data.unresponsive_engines
      .map(([engine, reason]) => reason ? `${engine} (${reason})` : engine)
      .join(", ");
    sections.push(`Unresponsive engines: ${engines}`);
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
  categories?: string
) {
  const startTime = Date.now();
  const operatorMax = getOperatorMaxResults(mcpServer);
  const effectiveMax = operatorMax !== undefined
    ? (num_results !== undefined ? Math.min(num_results, operatorMax) : operatorMax)
    : num_results;
  const maxResultChars = getMaxResultChars(mcpServer);

  const effectiveLanguage = language ?? getDefaultLanguage();
  const effectiveSafesearch = safesearch !== undefined ? safesearch : getDefaultSafesearch(mcpServer);

  // Build detailed log message with all parameters
  const searchParams = [
    `page ${pageno}`,
    `lang: ${effectiveLanguage}`,
    time_range ? `time: ${time_range}` : null,
    effectiveSafesearch !== undefined ? `safesearch: ${effectiveSafesearch}` : null,
    min_score !== undefined ? `min_score: ${min_score}` : null,
    effectiveMax !== undefined ? `num_results: ${effectiveMax}` : null,
    categories ? `categories: ${categories}` : null,
  ].filter(Boolean).join(", ");
  
  logMessage(mcpServer, "info", `Starting web search: "${query}" (${searchParams})`);
  
  const validationError = validateEnvironment();
  if (validationError) {
    logMessage(mcpServer, "error", "Configuration invalid");
    throw new MCPSearXNGError(validationError);
  }

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

  if (categories) {
    url.searchParams.set("categories", categories);
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
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);

  let response: Response;
  try {
    logMessage(mcpServer, "info", `Making request to: ${url.toString()}`);
    response = await fetch(url.toString(), {
      ...requestOptions,
      signal: controller.signal,
    });
  } catch (error: any) {
    clearTimeout(timeoutId);
    logMessage(mcpServer, "error", `Network error during search request: ${error.message}`, { query, url: url.toString() });
    const context: ErrorContext = {
      url: url.toString(),
      searxngUrl,
      proxyAgent: !!dispatcher,
      username
    };
    throw createNetworkError(error, context);
  }
  clearTimeout(timeoutId);

  if (!response.ok) {
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

  // Parse JSON response
  let data: SearXNGWeb;
  try {
    data = (await response.json()) as SearXNGWeb;
  } catch (error: any) {
    let responseText: string;
    try {
      responseText = await response.text();
    } catch {
      responseText = '[Could not read response text]';
    }

    const context: ErrorContext = { url: url.toString() };
    throw createJSONError(responseText, context);
  }

  if (!data.results) {
    const context: ErrorContext = { url: url.toString(), query };
    throw createDataError(data, context);
  }

  const results = data.results
    .map((result) => ({
      title: result.title || "",
      content: result.content || "",
      url: result.url || "",
      score: result.score || 0,
    }))
    .filter((result) => min_score === undefined || result.score >= min_score);
  const slicedResults = effectiveMax !== undefined
    ? results.slice(0, effectiveMax)
    : results;

  if (slicedResults.length === 0) {
    const appliedFilters = [
      min_score === undefined ? null : `min_score=${min_score}`,
      effectiveMax === undefined ? null : `num_results=${effectiveMax}`,
    ].filter(Boolean).join(" ");
    const filterNote = appliedFilters ? ` after applying ${appliedFilters}` : "";
    logMessage(mcpServer, "info", `No results found for query: "${query}"${filterNote}`);
    return createNoResultsMessage(query);
  }

  const duration = Date.now() - startTime;
  logMessage(mcpServer, "info", `Search completed: "${query}" (${searchParams}) - ${slicedResults.length} results in ${duration}ms`);

  const formattedResults = slicedResults
    .map((r) => `Title: ${r.title}\nDescription: ${truncateResultContent(r.content, maxResultChars)}\nURL: ${r.url}\nRelevance Score: ${r.score.toFixed(3)}`)
    .join("\n\n");
  const metadata = formatSearchMetadata(data);

  return metadata ? `${metadata}\n\n---\n\n${formattedResults}` : formattedResults;
}
