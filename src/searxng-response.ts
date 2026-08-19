import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { parseStrictInteger } from "./env-int.js";
import { logMessage } from "./logging.js";

export const DEFAULT_SEARXNG_RESPONSE_MAX_BYTES = 5 * 1024 * 1024;
export const HARD_MAX_SEARXNG_RESPONSE_BYTES = 16 * 1024 * 1024;
export const PREVIEW_MAX_SEARXNG_RESPONSE_BYTES = 64 * 1024;

const INVALID_RESPONSE_BODY_MESSAGE = "Invalid SearXNG response body";
const RESPONSE_TOO_LARGE_MESSAGE = "SearXNG response exceeds configured byte limit";
let warnedInvalidConfigurationServers = new WeakSet<object>();

export interface SearxngResponseReadOptions {
  preview?: boolean;
  previewMaxBytes?: number;
}

export interface SearxngResponseReadResult {
  text: string;
  bytesRead: number;
  truncated: boolean;
}

export function resetSearxngResponseConfigWarningsForTesting(): void {
  warnedInvalidConfigurationServers = new WeakSet<object>();
}

export function resolveSearxngResponseMaxBytes(mcpServer: McpServer): number {
  const rawValue = process.env.SEARXNG_MAX_RESPONSE_BYTES;
  if (rawValue === undefined || rawValue.trim() === "") {
    return DEFAULT_SEARXNG_RESPONSE_MAX_BYTES;
  }

  const parsed = parseStrictInteger(rawValue);
  if (parsed !== undefined && parsed >= 1 && parsed <= HARD_MAX_SEARXNG_RESPONSE_BYTES) {
    return parsed;
  }

  if (!warnedInvalidConfigurationServers.has(mcpServer)) {
    warnedInvalidConfigurationServers.add(mcpServer);
    logMessage(
      mcpServer,
      "warning",
      "Ignoring invalid SEARXNG_MAX_RESPONSE_BYTES; using the safe default response limit.",
    );
  }
  return DEFAULT_SEARXNG_RESPONSE_MAX_BYTES;
}

function concatenateChunks(chunks: Uint8Array[], totalBytes: number): Uint8Array {
  const result = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function responseBodyOrThrow(response: Response): ReadableStream<Uint8Array> | null {
  if (response === null || typeof response !== "object" || !("body" in response)) {
    throw new Error(INVALID_RESPONSE_BODY_MESSAGE);
  }
  if (response.body === null) {
    return null;
  }
  if (response.body === undefined || typeof response.body.getReader !== "function") {
    throw new Error(INVALID_RESPONSE_BODY_MESSAGE);
  }
  return response.body;
}

async function bestEffortCancel(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // A cancelled network body is best effort; it must not replace the bounded result.
  }
}

export async function readSearxngResponseBody(
  response: Response,
  maxBytes: number,
  options: SearxngResponseReadOptions = {},
): Promise<SearxngResponseReadResult> {
  const body = responseBodyOrThrow(response);
  if (body === null) {
    return { text: "", bytesRead: 0, truncated: false };
  }

  const preview = options.preview === true;
  const previewLimit = options.previewMaxBytes ?? PREVIEW_MAX_SEARXNG_RESPONSE_BYTES;
  const effectiveLimit = preview ? Math.min(maxBytes, previewLimit) : maxBytes;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let bytesRetained = 0;
  let bytesRead = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }

      bytesRead += value.byteLength;
      const remaining = effectiveLimit - bytesRetained;
      if (value.byteLength > remaining) {
        if (preview && remaining > 0) {
          chunks.push(value.subarray(0, remaining));
          bytesRetained += remaining;
        }
        await bestEffortCancel(reader);
        if (preview) {
          return {
            text: new TextDecoder("utf-8").decode(concatenateChunks(chunks, bytesRetained)),
            bytesRead,
            truncated: true,
          };
        }
        throw new Error(RESPONSE_TOO_LARGE_MESSAGE);
      }

      chunks.push(value);
      bytesRetained += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  return {
    text: new TextDecoder("utf-8").decode(concatenateChunks(chunks, bytesRetained)),
    bytesRead,
    truncated: false,
  };
}

export async function cancelAuxiliaryResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Auxiliary response cleanup cannot hide the useful upstream outcome.
  }
}
