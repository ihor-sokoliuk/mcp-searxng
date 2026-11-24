import { McpServer } from "@modelcontextprotocol/server";
import { logMessage } from "./logging.js";
import { applySearchRequestConfig, fetchSearxng } from "./proxy.js";
import {
  cancelAuxiliaryResponseBody,
  readSearxngResponseBody,
  resolveSearxngResponseMaxBytes,
} from "./searxng-response.js";
import { getSearxngInstances, suggestionHealth, stripSearxngInstanceUrlUserinfo } from "./searxng-instances.js";

export async function performSearchSuggestions(
  mcpServer: McpServer,
  query: string,
  language: string = "all",
): Promise<string[]> {
  const instances = getSearxngInstances();
  const replicas = instances.length > 1;
  const responseMaxBytes = resolveSearxngResponseMaxBytes(mcpServer);
  for (const base of replicas ? suggestionHealth.healthyInstances(instances) : instances) {
    try {
      const result = await requestSuggestions(base, query, language, responseMaxBytes);
      if (result !== undefined) {
        suggestionHealth.recordSuccess(base);
        return result;
      }
    } catch {
      // Transport, timeout and malformed response failures can be retried on a replica.
    }
    if (replicas) suggestionHealth.recordFailure(base);
  }
  if (instances.length) logMessage(mcpServer, "debug", "Autocomplete request failed; returning empty suggestions");
  return [];
}

async function requestSuggestions(
  base: string, query: string, language: string, responseMaxBytes: number,
): Promise<string[] | undefined> {
  const parsedBase = new URL(base.endsWith("/") ? base : `${base}/`);
  const url = new URL("autocompleter", parsedBase);
  url.searchParams.set("q", query);
  if (language !== "all") {
    url.searchParams.set("lang", language);
  }
  const requestUrl = stripSearxngInstanceUrlUserinfo(url);

  const signal = AbortSignal.timeout(5000);
  const requestOptions: RequestInit = {
    signal,
  };
  applySearchRequestConfig(requestOptions, url.toString());

  const response = await fetchSearxng(requestUrl.toString(), requestOptions);
  if (!response.ok) {
    await cancelAuxiliaryResponseBody(response);
    return undefined;
  }

  const { text } = await readSearxngResponseBody(response, responseMaxBytes, { signal });
  const data: unknown = JSON.parse(text);
  if (Array.isArray(data) && typeof data[0] === "string" && Array.isArray(data[1]) &&
      data[1].every((item: unknown) => typeof item === "string")) {
    return data[1];
  }
  return undefined;
}
