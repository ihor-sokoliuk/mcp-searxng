import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { logMessage } from "./logging.js";
import { applySearchRequestConfig } from "./proxy.js";
import { getPrimarySearxngInstance, stripSearxngInstanceUrlUserinfo } from "./searxng-instances.js";

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
  const requestUrl = stripSearxngInstanceUrlUserinfo(url);
  url.searchParams.set("q", query);
  if (language !== "all") {
    url.searchParams.set("lang", language);
  }
  requestUrl.search = url.search;

  try {
    const requestOptions: RequestInit = {
      signal: AbortSignal.timeout(5000),
    };
    applySearchRequestConfig(requestOptions, url.toString());

    const response = await fetch(requestUrl.toString(), requestOptions);
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
