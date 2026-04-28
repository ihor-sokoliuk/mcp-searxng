import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SearXNGResponse, normalizeCategories } from "./types.js";
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

function formatValue(value: unknown): string {
  if (Array.isArray(value)) {
    if (value.every(v => typeof v !== "object" || v === null)) {
      return value.join(", ");
    }
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  if (typeof value === "object" && value !== null) {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function formatResult(result: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(result)) {
    if (value === null || value === undefined) continue;
    if (value === "") continue;
    if (Array.isArray(value) && value.length === 0) continue;
    lines.push(`${key}: ${formatValue(value)}`);
  }
  return lines.join("\n");
}

function formatTopLevelData(data: SearXNGResponse): string {
  const sections: string[] = [];

  if (data.answers && data.answers.length > 0) {
    sections.push("## Answers\n" + data.answers.map((a: string) => `- ${a}`).join("\n"));
  }

  if (data.suggestions && data.suggestions.length > 0) {
    sections.push("## Suggestions\n" + data.suggestions.map((s: string) => `- ${s}`).join("\n"));
  }

  if (data.corrections && data.corrections.length > 0) {
    sections.push("## Corrections\n" + data.corrections.map((c: string) => `- ${c}`).join("\n"));
  }

  if (data.infoboxes && data.infoboxes.length > 0) {
    const infoboxLines = data.infoboxes.map((ib: Record<string, unknown>, i: number) => {
      const entries = Object.entries(ib)
        .filter(([, v]) => v !== null && v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0))
        .map(([k, v]) => `${k}: ${formatValue(v)}`);
      return `### Infobox ${i + 1}\n${entries.join("\n")}`;
    });
    sections.push("## Infoboxes\n" + infoboxLines.join("\n\n"));
  }

  return sections.join("\n\n");
}

export async function performWebSearch(
  mcpServer: McpServer,
  query: string,
  pageno: number = 1,
  time_range?: string,
  language: string = "all",
  safesearch?: number,
  categories?: string,
  response_format?: string
) {
  const startTime = Date.now();
  
  const searchParams = [
    `page ${pageno}`,
    `lang: ${language}`,
    time_range ? `time: ${time_range}` : null,
    safesearch !== undefined ? `safesearch: ${safesearch}` : null,
    categories ? `categories: ${categories}` : null,
    response_format ? `format: ${response_format}` : null
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
    ["day", "month", "year"].includes(time_range)
  ) {
    url.searchParams.set("time_range", time_range);
  }

  if (language && language !== "all") {
    url.searchParams.set("language", language);
  }

  if (safesearch !== undefined && [0, 1, 2].includes(safesearch)) {
    url.searchParams.set("safesearch", safesearch.toString());
  }

  if (categories) {
    const normalized = normalizeCategories(categories);
    if (normalized) {
      url.searchParams.set("categories", normalized);
    }
  }

  const requestOptions: RequestInit = {
    method: "GET"
  };

  const proxyAgent = createProxyAgent(url.toString(), ProxyType.SEARCH);
  const dispatcher = proxyAgent ?? createDefaultAgent();
  if (dispatcher) {
    (requestOptions as any).dispatcher = dispatcher;
  }

  const username = process.env.AUTH_USERNAME;
  const password = process.env.AUTH_PASSWORD;

  if (username && password) {
    const base64Auth = Buffer.from(`${username}:${password}`).toString('base64');
    requestOptions.headers = {
      ...requestOptions.headers,
      'Authorization': `Basic ${base64Auth}`
    };
  }

  const userAgent = process.env.USER_AGENT;
  if (userAgent) {
    requestOptions.headers = {
      ...requestOptions.headers,
      'User-Agent': userAgent
    };
  }

  let response: Response;
  try {
    logMessage(mcpServer, "info", `Making request to: ${url.toString()}`);
    response = await fetch(url.toString(), requestOptions);
  } catch (error: any) {
    logMessage(mcpServer, "error", `Network error during search request: ${error.message}`, { query, url: url.toString() });
    const context: ErrorContext = {
      url: url.toString(),
      searxngUrl,
      proxyAgent: !!dispatcher,
      username
    };
    throw createNetworkError(error, context);
  }

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

  let data: SearXNGResponse;
  try {
    data = (await response.json()) as SearXNGResponse;
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

  if (data.results.length === 0) {
    logMessage(mcpServer, "info", `No results found for query: "${query}"`);
    return createNoResultsMessage(query);
  }

  const isFullFormat = response_format === "full";

  let output: string;
  if (isFullFormat) {
    // Full passthrough: all fields, --- separators, top-level data sections
    const formattedResults = data.results
      .map((result) => formatResult(result))
      .join("\n---\n");

    const topLevelData = formatTopLevelData(data);
    output = topLevelData
      ? `${formattedResults}\n\n${topLevelData}`
      : formattedResults;
  } else {
    // Classic format: backward-compatible Title/Description/URL/Score
    const results = data.results.map((result) => {
      const score = Number(result.score);
      const formattedScore = isNaN(score) ? "0.000" : score.toFixed(3);
      return `Title: ${result.title || ""}\nDescription: ${result.content || ""}\nURL: ${result.url || ""}\nRelevance Score: ${formattedScore}`;
    });
    output = results.join("\n\n");
  }

  const duration = Date.now() - startTime;
  logMessage(mcpServer, "info", `Search completed: "${query}" (${searchParams}) - ${data.results.length} results in ${duration}ms`);

  return output;
}
