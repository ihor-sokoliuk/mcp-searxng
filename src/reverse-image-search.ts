import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SearXNGWeb } from "./types.js";
import { normalizeSearchFilters } from "./search.js";
import { createProxyAgent, createDefaultAgent, ProxyType } from "./proxy.js";
import { logMessage } from "./logging.js";
import {
  MCPSearXNGError,
  validateEnvironment,
  createNetworkError,
  createServerError,
  createJSONError,
  createDataError,
  type ErrorContext,
} from "./error-handler.js";

function getOperatorMaxResults(mcpServer: McpServer): number | undefined {
  const rawValue = process.env.SEARXNG_MAX_RESULTS;
  if (rawValue === undefined || rawValue.trim() === "") return undefined;
  const parsed = parseInt(rawValue, 10);
  if (Number.isNaN(parsed) || parsed <= 0 || parsed > 20) {
    logMessage(mcpServer, "warning", `Ignoring invalid SEARXNG_MAX_RESULTS="${rawValue}".`);
    return undefined;
  }
  return parsed;
}

function getDefaultLanguage(): string {
  return process.env.SEARXNG_DEFAULT_LANGUAGE ?? "all";
}

export async function performReverseImageSearch(
  mcpServer: McpServer,
  image_url: string,
  pageno: number = 1,
  engines?: string,
  categories?: string,
  time_range?: string,
  language?: string,
  safesearch?: number,
  min_score?: number,
  num_results?: number,
  response_format: "text" | "json" = "text",
): Promise<string> {
  if (!/^https?:\/\//i.test(image_url)) {
    throw new MCPSearXNGError(
      '🖼️ reverse_image_search requires "image_url" to be a direct http(s) URL to an image.',
    );
  }

  const validationError = validateEnvironment();
  if (validationError) {
    throw new MCPSearXNGError(validationError);
  }

  const operatorMax = getOperatorMaxResults(mcpServer);
  const effectiveMax = operatorMax !== undefined
    ? (num_results !== undefined ? Math.min(num_results, operatorMax) : operatorMax)
    : num_results;

  const effectiveLanguage = language ?? getDefaultLanguage();

  const filters = await normalizeSearchFilters(mcpServer, categories, engines ?? "tineye");

  const searchParams = [
    `page ${pageno}`,
    `lang: ${effectiveLanguage}`,
    time_range ? `time: ${time_range}` : null,
    safesearch !== undefined ? `safesearch: ${safesearch}` : null,
    min_score !== undefined ? `min_score: ${min_score}` : null,
    effectiveMax !== undefined ? `num_results: ${effectiveMax}` : null,
    filters.categories ? `categories: ${filters.categories}` : null,
    filters.engines ? `engines: ${filters.engines}` : null,
  ].filter(Boolean).join(", ");

  logMessage(mcpServer, "info", `Starting reverse image search: ${image_url} (${searchParams})`);

  const searxngUrl = process.env.SEARXNG_URL!;
  const parsedBase = new URL(searxngUrl.endsWith("/") ? searxngUrl : searxngUrl + "/");
  const url = new URL("search", parsedBase);

  url.searchParams.set("q", image_url);
  url.searchParams.set("format", "json");
  url.searchParams.set("pageno", pageno.toString());

  if (time_range !== undefined && ["day", "week", "month", "year"].includes(time_range)) {
    url.searchParams.set("time_range", time_range);
  }
  if (effectiveLanguage && effectiveLanguage !== "all") {
    url.searchParams.set("language", effectiveLanguage);
  }
  if (safesearch !== undefined && [0, 1, 2].includes(safesearch)) {
    url.searchParams.set("safesearch", safesearch.toString());
  }
  if (filters.categories) {
    url.searchParams.set("categories", filters.categories);
  }
  if (filters.engines) {
    url.searchParams.set("engines", filters.engines);
  }

  const requestOptions: RequestInit = { method: "GET" };

  const proxyAgent = createProxyAgent(url.toString(), ProxyType.SEARCH);
  const dispatcher = proxyAgent ?? createDefaultAgent();
  if (dispatcher) {
    (requestOptions as any).dispatcher = dispatcher;
  }

  const username = process.env.AUTH_USERNAME;
  const password = process.env.AUTH_PASSWORD;
  if (username && password) {
    const base64Auth = Buffer.from(`${username}:${password}`).toString("base64");
    requestOptions.headers = { ...requestOptions.headers, Authorization: `Basic ${base64Auth}` };
  }

  const userAgent = process.env.USER_AGENT;
  if (userAgent) {
    requestOptions.headers = { ...requestOptions.headers, "User-Agent": userAgent };
  }

  const TIMEOUT_MS = parseInt(process.env.SEARXNG_TIMEOUT_MS ?? "10000", 10);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let response: Response;
  try {
    logMessage(mcpServer, "info", `Making request to: ${url.toString()}`);
    response = await fetch(url.toString(), { ...requestOptions, signal: controller.signal });
  } catch (error: any) {
    clearTimeout(timeoutId);
    const context: ErrorContext = { url: url.toString(), searxngUrl, proxyAgent: !!dispatcher, username };
    throw createNetworkError(error, context);
  }
  clearTimeout(timeoutId);

  if (!response.ok) {
    let responseBody: string;
    try {
      responseBody = await response.text();
    } catch {
      responseBody = "[Could not read response body]";
    }
    const context: ErrorContext = { url: url.toString(), searxngUrl };
    throw createServerError(response.status, response.statusText, responseBody, context);
  }

  let data: SearXNGWeb;
  try {
    data = (await response.json()) as SearXNGWeb;
  } catch (error: any) {
    let responseText: string;
    try {
      responseText = await response.text();
    } catch {
      responseText = "[Could not read response text]";
    }
    const context: ErrorContext = { url: url.toString() };
    throw createJSONError(responseText, context);
  }

  if (!data.results) {
    const context: ErrorContext = { url: url.toString(), query: image_url };
    throw createDataError(data, context);
  }

  const results = data.results.filter(
    (r) => min_score === undefined || (r.score || 0) >= min_score,
  );
  const slicedResults = effectiveMax !== undefined ? results.slice(0, effectiveMax) : results;

  logMessage(mcpServer, "info", `Reverse image search completed: ${slicedResults.length} results`);

  if (response_format === "json") {
    return JSON.stringify(
      {
        image_url,
        ...data,
        results: slicedResults,
        ...(filters.validationWarning ? { warnings: [filters.validationWarning] } : {}),
      },
      null,
      2,
    );
  }

  // text format
  const leadingNote = filters.validationNote ?? null;

  if (slicedResults.length === 0) {
    const noResults = `No reverse image search results found for: ${image_url}`;
    return leadingNote ? `${leadingNote}\n\n${noResults}` : noResults;
  }

  const formatted = slicedResults
    .map((r) => {
      const score = r.score || 0;
      const lines = [
        `Title: ${r.title || ""}`,
        `URL: ${r.url || ""}`,
        `Relevance Score: ${score.toFixed(3)}`,
      ];
      if (r.content) lines.push(`Description: ${r.content}`);
      if (r.img_src) lines.push(`Image: ${r.img_src}`);
      if (r.engine) lines.push(`Engine: ${r.engine}`);
      return lines.join("\n");
    })
    .join("\n\n");

  const header = `Reverse image search results for: ${image_url}\nTotal results: ${data.number_of_results ?? data.results.length}`;
  const body = leadingNote
    ? `${leadingNote}\n\n---\n\n${header}\n\n---\n\n${formatted}`
    : `${header}\n\n---\n\n${formatted}`;

  return body;
}
