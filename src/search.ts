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

export async function performWebSearch(
  mcpServer: McpServer,
  query: string,
  pageno: number = 1,
  time_range?: string,
  language: string = "all",
  safesearch?: number,
  engines?: string[],
  categories?: string[]
) {
  const startTime = Date.now();
  
  // Build detailed log message with all parameters
  const searchParams = [
    `page ${pageno}`,
    `lang: ${language}`,
    time_range ? `time: ${time_range}` : null,
    safesearch ? `safesearch: ${safesearch}` : null
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

  if (engines && engines.length > 0) {
    url.searchParams.set("engines", engines.join(","));
  }

  if (categories && categories.length > 0) {
    url.searchParams.set("categories", categories.join(","));
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

  // Fetch with enhanced error handling
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
    logMessage(mcpServer, "info", `No results found for query: "${query}"`);
    return createNoResultsMessage(query);
  }

  const duration = Date.now() - startTime;
  logMessage(mcpServer, "info", `Search completed: "${query}" (${searchParams}) - ${results.length} results in ${duration}ms`);

  return results
    .map((r) => `Title: ${r.title}\nDescription: ${r.content}\nURL: ${r.url}\nRelevance Score: ${r.score.toFixed(3)}`)
    .join("\n\n");
}

export async function performMultiSearch(
  mcpServer: McpServer,
  queries: string[],
  pageno: number = 1,
  time_range?: string,
  language: string = "all",
  safesearch?: number,
  engines?: string[],
  categories?: string[]
) {
  const startTime = Date.now();
  
  logMessage(mcpServer, "info", `Starting multi-search: ${queries.length} queries`);

  const validationError = validateEnvironment();
  if (validationError) {
    throw new MCPSearXNGError(validationError);
  }

  // Limit to 5 queries
  const limitedQueries = queries.slice(0, 5);

  // Helper: build search URL for a single query
  function buildSearchUrl(query: string): URL {
    const searxngUrl = process.env.SEARXNG_URL!;
    const parsedUrl = new URL(searxngUrl.endsWith('/') ? searxngUrl : searxngUrl + '/');
    const url = new URL('search', parsedUrl);
    url.searchParams.set("q", query);
    url.searchParams.set("format", "json");
    url.searchParams.set("pageno", pageno.toString());
    if (time_range !== undefined && ["day", "month", "year"].includes(time_range)) {
      url.searchParams.set("time_range", time_range);
    }
    if (language && language !== "all") {
      url.searchParams.set("language", language);
    }
    if (safesearch !== undefined && [0, 1, 2].includes(safesearch)) {
      url.searchParams.set("safesearch", safesearch.toString());
    }
    if (engines && engines.length > 0) {
      url.searchParams.set("engines", engines.join(","));
    }
    if (categories && categories.length > 0) {
      url.searchParams.set("categories", categories.join(","));
    }
    return url;
  }

  // Helper: fetch single query with delay
  async function searchSingle(query: string, delayMs: number): Promise<{
    query: string;
    success: boolean;
    results: Array<{ title: string; content: string; url: string; score: number }>;
    error?: string;
  }> {
    // Stagger requests to avoid CAPTCHA
    if (delayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }

    try {
      const url = buildSearchUrl(query);
      const requestOptions: RequestInit = { method: "GET" };

      const proxyAgent = createProxyAgent(url.toString(), ProxyType.SEARCH);
      const dispatcher = proxyAgent ?? createDefaultAgent();
      if (dispatcher) {
        (requestOptions as any).dispatcher = dispatcher;
      }

      const username = process.env.AUTH_USERNAME;
      const password = process.env.AUTH_PASSWORD;
      if (username && password) {
        const base64Auth = Buffer.from(`${username}:${password}`).toString('base64');
        requestOptions.headers = { ...requestOptions.headers, 'Authorization': `Basic ${base64Auth}` };
      }

      const userAgent = process.env.USER_AGENT;
      if (userAgent) {
        requestOptions.headers = { ...requestOptions.headers, 'User-Agent': userAgent };
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);
      requestOptions.signal = controller.signal;

      const response = await fetch(url.toString(), requestOptions);
      clearTimeout(timeoutId);

      if (!response.ok) {
        return { query, success: false, results: [], error: `HTTP ${response.status}` };
      }

      const data = await response.json() as any;
      if (!data.results) {
        return { query, success: false, results: [], error: "No results field in response" };
      }

      const results = data.results.map((r: any) => ({
        title: r.title || "",
        content: r.content || "",
        url: r.url || "",
        score: r.score || 0,
      }));

      return { query, success: true, results };
    } catch (error: any) {
      return { query, success: false, results: [], error: error.message || "Unknown error" };
    }
  }

  // Execute all queries in parallel with staggered starts (100ms apart)
  const searchPromises = limitedQueries.map((query, index) =>
    searchSingle(query, index * 100)
  );

  const searchResults = await Promise.all(searchPromises);

  // Format output
  const duration = Date.now() - startTime;
  const successful = searchResults.filter(r => r.success).length;
  const failed = searchResults.filter(r => !r.success).length;

  const parts: string[] = [];
  parts.push(`Multi-Search Results (${limitedQueries.length} queries, ${successful} successful, ${failed} failed) — ${duration}ms\n`);

  for (const result of searchResults) {
    parts.push(`=== Query: "${result.query}" ===`);
    if (!result.success) {
      parts.push(`FAILED: ${result.error}\n`);
      continue;
    }
    if (result.results.length === 0) {
      parts.push(`No results found.\n`);
      continue;
    }
    for (const r of result.results.slice(0, 5)) {
      parts.push(`Title: ${r.title}`);
      parts.push(`URL: ${r.url}`);
      parts.push(`Score: ${r.score.toFixed(3)}`);
      if (r.content) parts.push(`Snippet: ${r.content.slice(0, 200)}`);
      parts.push('');
    }
  }

  logMessage(mcpServer, "info", `Multi-search completed: ${successful}/${limitedQueries.length} successful in ${duration}ms`);
  
  return parts.join("\n");
}
