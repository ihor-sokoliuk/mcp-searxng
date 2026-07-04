import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { logMessage } from "./logging.js";
import { applySearchRequestConfig } from "./proxy.js";
import { getPrimarySearxngInstance } from "./searxng-instances.js";

export async function performSearchSuggestions(
  mcpServer: McpServer,
  query: string,
  language: string = "all",
): Promise<string[]> {
  const base = getPrimarySearxngInstance();
  if (!base) {
    return [];
  }

  const parsedBase = new URL(base.endsWith("/") ? base : `${base}/`);
  const url = new URL("autocompleter", parsedBase);
  url.searchParams.set("q", query);
  if (language !== "all") {
    url.searchParams.set("lang", language);
  }

  try {
    const requestOptions: RequestInit = {
      signal: AbortSignal.timeout(5000),
    };
    applySearchRequestConfig(requestOptions, url.toString());

    const response = await fetch(url.toString(), requestOptions);
    if (!response.ok) {
      return [];
    }

    const data = await response.json() as [string, string[]];
    return Array.isArray(data[1]) ? data[1] : [];
  } catch {
    logMessage(mcpServer, "debug", "Autocomplete request failed; returning empty suggestions");
    return [];
  }
}
