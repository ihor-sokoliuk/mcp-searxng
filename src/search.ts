import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SearXNGWeb } from "./types.js";
import { createProxyAgent } from "./proxy.js";
import { logMessage } from "./logging.js";
import {
  createConfigurationError,
  createNetworkError,
  createServerError,
  createJSONError,
  createDataError,
  createNoResultsMessage,
  type ErrorContext
} from "./error-handler.js";

export async function performWebSearch(
  server: Server,
  query: string,
  pageno: number = 1,
  time_range?: string,
  language: string = "all",
  safesearch?: string
) {
  const startTime = Date.now();
  
  // Build detailed log message with all parameters
  const searchParams = [
    `page ${pageno}`,
    `lang: ${language}`,
    time_range ? `time: ${time_range}` : null,
    safesearch ? `safesearch: ${safesearch}` : null
  ].filter(Boolean).join(", ");
  
  logMessage(server, "info", `Starting web search: "${query}" (${searchParams})`);
  
  const searxngUrl = process.env.SEARXNG_URL;

  if (!searxngUrl) {
    logMessage(server, "error", "SEARXNG_URL not configured");
    throw createConfigurationError(
      "SEARXNG_URL not set. Set it to your SearXNG instance (e.g., http://localhost:8080 or https://search.example.com)"
    );
  }

  // Validate that searxngUrl is a valid URL
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(searxngUrl);
  } catch (error) {
    throw createConfigurationError(
      `Invalid SEARXNG_URL format: ${searxngUrl}. Use format: http://localhost:8080`
    );
  }

  const url = new URL('/search', parsedUrl);

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

  if (safesearch !== undefined && ["0", "1", "2"].includes(safesearch)) {
    url.searchParams.set("safesearch", safesearch);
  }

  // Prepare request options with headers
  const requestOptions: RequestInit = {
    method: "GET"
  };

  // Add proxy dispatcher if proxy is configured
  // Node.js fetch uses 'dispatcher' option for proxy, not 'agent'
  const proxyAgent = createProxyAgent(url.toString());
  if (proxyAgent) {
    (requestOptions as any).dispatcher = proxyAgent;
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

  // Fetch with enhanced error handling
  let response: Response;
  try {
    logMessage(server, "info", `Making request to: ${url.toString()}`);
    response = await fetch(url.toString(), requestOptions);
  } catch (error: any) {
    logMessage(server, "error", `Network error during search request: ${error.message}`, { query, url: url.toString() });
    const context: ErrorContext = {
      url: url.toString(),
      searxngUrl,
      proxyAgent: !!proxyAgent,
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

  const results = data.results.map((result) => ({
    title: result.title || "",
    content: result.content || "",
    url: result.url || "",
    score: result.score || 0,
  }));

  if (results.length === 0) {
    logMessage(server, "info", `No results found for query: "${query}"`);
    return createNoResultsMessage(query);
  }

  const duration = Date.now() - startTime;
  logMessage(server, "info", `Search completed: "${query}" (${searchParams}) - ${results.length} results in ${duration}ms`);

  return results
    .map((r) => `Title: ${r.title}\nDescription: ${r.content}\nURL: ${r.url}\nRelevance Score: ${r.score.toFixed(3)}`)
    .join("\n\n");
}
