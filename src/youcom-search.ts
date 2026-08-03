import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SearXNGWeb, SearXNGWebResult } from "./types.js";
import { logMessage } from "./logging.js";
import { applySearchRequestConfig } from "./proxy.js";
import {
  MCPSearXNGError,
  createNetworkError,
  createServerError,
  createJSONError,
  createDataError,
  type ErrorContext
} from "./error-handler.js";

interface YouComSearchRequest {
  query: string;
  count?: number;
  domains?: string[];
  freshness?: "hour" | "day" | "week" | "month" | "year";
  safeSearch?: boolean;
}

interface YouComSearchResponse {
  results: {
    web?: Array<{
      url: string;
      title: string;
      snippet: string;
      publishedDate?: string;
    }>;
    news?: Array<{
      url: string;
      title: string;
      snippet: string;
      publishedDate?: string;
    }>;
  };
  responseMetadata: {
    query: string;
    resultsCount: number;
  };
}

/**
 * Gets the You.com API key from environment, returns undefined if not set
 * (allowing keyless operation)
 */
function getYouComApiKey(): string | undefined {
  return process.env.YDC_API_KEY?.trim() || undefined;
}

/**
 * Builds You.com Search API URL with query parameters
 */
function buildYouComSearchUrl(request: YouComSearchRequest): URL {
  const url = new URL("https://api.you.com/v1/agents/search");
  
  url.searchParams.set("query", request.query);
  
  if (request.count !== undefined && request.count > 0 && request.count <= 20) {
    url.searchParams.set("count", request.count.toString());
  }
  
  if (request.domains && request.domains.length > 0) {
    url.searchParams.set("domains", request.domains.join(","));
  }
  
  if (request.freshness) {
    url.searchParams.set("freshness", request.freshness);
  }
  
  if (request.safeSearch !== undefined) {
    url.searchParams.set("safeSearch", request.safeSearch.toString());
  }
  
  return url;
}

/**
 * Builds request options for You.com API including auth if available
 */
function buildYouComRequestOptions(url: URL): RequestInit {
  const requestOptions: RequestInit = {
    method: "GET",
    headers: {
      "Accept": "application/json",
      "User-Agent": "mcp-searxng/1.0"
    }
  };

  // Add API key if available
  const apiKey = getYouComApiKey();
  if (apiKey) {
    (requestOptions.headers as Record<string, string>)["Authorization"] = `Bearer ${apiKey}`;
  }

  // Apply proxy configuration
  applySearchRequestConfig(requestOptions, url.toString());

  return requestOptions;
}

/**
 * Converts You.com response format to SearXNG format for compatibility
 */
function convertYouComResponseToSearXNG(response: YouComSearchResponse): SearXNGWeb {
  const results: SearXNGWebResult[] = [];
  
  // Combine web and news results
  const webResults = response.results.web || [];
  const newsResults = response.results.news || [];
  
  [...webResults, ...newsResults].forEach((result, index) => {
    results.push({
      title: result.title,
      content: result.snippet,
      url: result.url,
      score: 1.0 - (index * 0.1), // Synthetic score based on position
      engine: "youcom",
      publishedDate: result.publishedDate,
    });
  });

  return {
    query: response.responseMetadata.query,
    number_of_results: results.length,
    results,
    sourceFormat: "json",
  };
}

/**
 * Performs web search using You.com Search API
 */
export async function performYouComWebSearch(
  mcpServer: McpServer,
  query: string,
  options: {
    pageno?: number;
    count?: number;
    domains?: string[];
    freshness?: string;
    safeSearch?: boolean;
    timeoutMs?: number;
  } = {}
): Promise<SearXNGWeb> {
  const { pageno = 1, count = 10, domains, freshness, safeSearch, timeoutMs = 10000 } = options;
  
  // You.com doesn't support pagination - return empty results for page > 1
  if (pageno > 1) {
    logMessage(mcpServer, "info", `You.com provider: Page ${pageno} requested, but pagination not supported. Returning empty results.`);
    return {
      query: query.trim(),
      number_of_results: 0,
      results: [],
      sourceFormat: "json",
    };
  }
  
  // Validate and normalize freshness
  const validFreshness = freshness && ["hour", "day", "week", "month", "year"].includes(freshness) 
    ? freshness as YouComSearchRequest["freshness"]
    : undefined;

  const request: YouComSearchRequest = {
    query: query.trim(),
    count: Math.max(1, Math.min(20, count)),
    domains: domains && domains.length > 0 ? domains : undefined,
    freshness: validFreshness,
    safeSearch,
  };

  const url = buildYouComSearchUrl(request);
  const requestOptions = buildYouComRequestOptions(url);
  
  logMessage(mcpServer, "info", `Making You.com search request: ${query}`);

  try {
    // Perform the search with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    
    let response: Response;
    try {
      response = await fetch(url.toString(), {
        ...requestOptions,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    // Handle HTTP errors
    if (!response.ok) {
      let responseBody: string;
      try {
        responseBody = await response.text();
      } catch {
        responseBody = '[Could not read response body]';
      }

      const context: ErrorContext = {
        url: url.toString(),
        searxngUrl: "youcom-api",
      };

      // Handle specific error codes
      if (response.status === 401) {
        logMessage(mcpServer, "error", "You.com API authentication failed. Check YDC_API_KEY environment variable.");
        throw createServerError(response.status, "Authentication failed", 
          "Invalid or missing API key. Set YDC_API_KEY environment variable or use keyless mode.", context);
      } else if (response.status === 429) {
        logMessage(mcpServer, "error", "You.com API rate limit exceeded. Consider upgrading your plan or retry later.");
        throw createServerError(response.status, "Rate limit exceeded", 
          "Too many requests. Upgrade your You.com plan for higher quotas or retry later.", context);
      } else if (response.status >= 500) {
        logMessage(mcpServer, "error", `You.com API server error: ${response.status} ${response.statusText}`);
        throw createServerError(response.status, "Service unavailable", 
          "You.com API is temporarily unavailable. Please retry later.", context);
      } else {
        throw createServerError(response.status, response.statusText, responseBody, context);
      }
    }

    // Parse JSON response
    let data: YouComSearchResponse;
    try {
      const text = await response.text();
      data = JSON.parse(text);
    } catch (error) {
      logMessage(mcpServer, "error", "Failed to parse You.com API response as JSON");
      const context: ErrorContext = {
        url: url.toString(),
        searxngUrl: "youcom-api",
      };
      throw createJSONError("Invalid JSON response from You.com API");
    }

    // Validate response structure
    if (!data || !data.results || !data.responseMetadata) {
      logMessage(mcpServer, "error", "You.com API response missing required fields");
      const context: ErrorContext = {
        url: url.toString(),
        searxngUrl: "youcom-api",
      };
      throw createDataError();
    }

    const convertedResponse = convertYouComResponseToSearXNG(data);
    
    logMessage(mcpServer, "info", 
      `You.com search completed: ${convertedResponse.results.length} results for "${query}"`);
    
    return convertedResponse;

  } catch (error) {
    if (error instanceof MCPSearXNGError) {
      throw error;
    }

    // Handle network/timeout errors
    logMessage(mcpServer, "error", `You.com API network error: ${error}`);
    const context: ErrorContext = {
      url: url.toString(),
      searxngUrl: "youcom-api",
    };
    throw createNetworkError(error as Error, context);
  }
}

/**
 * Checks if You.com search provider is configured and enabled
 */
export function isYouComSearchEnabled(): boolean {
  const provider = process.env.SEARCH_PROVIDER?.trim().toLowerCase();
  return provider === "youcom";
}

/**
 * Gets information about You.com search provider configuration
 */
export function getYouComProviderInfo() {
  const hasApiKey = !!getYouComApiKey();
  return {
    provider: "youcom",
    hasApiKey,
    mode: hasApiKey ? "authenticated" : "keyless",
    quotas: hasApiKey ? "Per your You.com plan" : "100 free searches/day per IP",
    endpoint: "https://api.you.com/v1/agents/search"
  };
}