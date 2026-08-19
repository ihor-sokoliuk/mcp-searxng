import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { logMessage } from "./logging.js";
import { applySearchRequestConfig, fetchSearxng } from "./proxy.js";
import {
  cancelAuxiliaryResponseBody,
  readSearxngResponseBody,
  resolveSearxngResponseMaxBytes,
} from "./searxng-response.js";
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
  const responseMaxBytes = resolveSearxngResponseMaxBytes(mcpServer);

  const parsedBase = new URL(base.endsWith("/") ? base : `${base}/`);
  const url = new URL("autocompleter", parsedBase);
  url.searchParams.set("q", query);
  if (language !== "all") {
    url.searchParams.set("lang", language);
  }
  const requestUrl = stripSearxngInstanceUrlUserinfo(url);

  try {
    const requestOptions: RequestInit = {
      signal: AbortSignal.timeout(5000),
    };
    applySearchRequestConfig(requestOptions, url.toString());

    const response = await fetchSearxng(requestUrl.toString(), requestOptions);
    if (!response.ok) {
      await cancelAuxiliaryResponseBody(response);
      return [];
    }

    const { text } = await readSearxngResponseBody(response, responseMaxBytes);
    const data = JSON.parse(text) as [string, string[]];
    return Array.isArray(data[1]) ? data[1] : [];
  } catch {
    logMessage(mcpServer, "debug", "Autocomplete request failed; returning empty suggestions");
    return [];
  }
}
