import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { parseStrictInteger } from "./env-int.js";
import { logMessage } from "./logging.js";

export const DEFAULT_SEARXNG_RESPONSE_MAX_BYTES = 5 * 1024 * 1024;
export const HARD_MAX_SEARXNG_RESPONSE_BYTES = 16 * 1024 * 1024;
export const PREVIEW_MAX_SEARXNG_RESPONSE_BYTES = 64 * 1024;

const INVALID_RESPONSE_BODY_MESSAGE = "Invalid SearXNG response body";
const RESPONSE_TOO_LARGE_MESSAGE = "SearXNG response exceeds configured byte limit";
const responseLimitErrors = new WeakSet<Error>();
let warnedInvalidConfigurationServers = new WeakSet<object>();

export interface SearxngResponseReadOptions {
  preview?: boolean;
  previewMaxBytes?: number;
  signal?: AbortSignal;
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

async function bestEffortCancel(reader: ReadableStreamDefaultReader<Uint8Array>, reason?: unknown): Promise<void> {
  try {
    await reader.cancel(reason);
  } catch {
    // A cancelled network body is best effort; it must not replace the bounded result.
  }
}

function abortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) {
    return signal.reason;
  }
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

function responseTooLargeError(): Error {
  const error = new Error(RESPONSE_TOO_LARGE_MESSAGE);
  responseLimitErrors.add(error);
  return error;
}

interface ResponseAccumulator {
  chunks: Uint8Array[];
  bytesRead: number;
  bytesRetained: number;
}

interface AbortReadRace {
  dispose(): void;
  read(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<ReadableStreamReadResult<Uint8Array>>;
  throwIfAborted(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void>;
}

function createAbortReadRace(signal: AbortSignal | undefined): AbortReadRace {
  let abortRequested = false;
  let abortedWith: unknown;
  let abortHandler: (() => void) | undefined;
  let abortPromise: Promise<never> | undefined;

  if (signal !== undefined) {
    abortPromise = new Promise<never>((_resolve, reject) => {
      abortHandler = () => {
        abortRequested = true;
        abortedWith = abortReason(signal);
        reject(abortedWith);
      };
      if (signal.aborted) abortHandler();
      else signal.addEventListener("abort", abortHandler, { once: true });
    });
  }

  return {
    dispose: () => {
      if (signal !== undefined && abortHandler !== undefined) signal.removeEventListener("abort", abortHandler);
    },
    read: (reader) => abortPromise === undefined
      ? reader.read()
      : Promise.race([reader.read(), abortPromise]),
    throwIfAborted: async (reader) => {
      if (abortRequested) {
        await bestEffortCancel(reader, abortedWith);
        throw abortedWith;
      }
    },
  };
}

function buildReadResult(accumulator: ResponseAccumulator, truncated: boolean): SearxngResponseReadResult {
  return {
    text: new TextDecoder("utf-8").decode(concatenateChunks(accumulator.chunks, accumulator.bytesRetained)),
    bytesRead: accumulator.bytesRead,
    truncated,
  };
}

async function retainResponseChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  value: Uint8Array | undefined,
  effectiveLimit: number,
  preview: boolean,
  accumulator: ResponseAccumulator,
): Promise<SearxngResponseReadResult | undefined> {
  if (!value) return undefined;

  accumulator.bytesRead += value.byteLength;
  const remaining = effectiveLimit - accumulator.bytesRetained;
  if (value.byteLength <= remaining) {
    accumulator.chunks.push(value);
    accumulator.bytesRetained += value.byteLength;
    return undefined;
  }

  if (preview && remaining > 0) {
    accumulator.chunks.push(value.subarray(0, remaining));
    accumulator.bytesRetained += remaining;
  }
  await bestEffortCancel(reader);
  if (preview) return buildReadResult(accumulator, true);
  throw responseTooLargeError();
}

async function consumeResponseBody(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  effectiveLimit: number,
  preview: boolean,
  signal: AbortSignal | undefined,
): Promise<SearxngResponseReadResult> {
  const accumulator: ResponseAccumulator = { chunks: [], bytesRead: 0, bytesRetained: 0 };
  const abortRace = createAbortReadRace(signal);

  try {
    while (true) {
      const { done, value } = await abortRace.read(reader);
      if (done) return buildReadResult(accumulator, false);
      const truncated = await retainResponseChunk(reader, value, effectiveLimit, preview, accumulator);
      if (truncated !== undefined) return truncated;
    }
  } catch (error) {
    if (error instanceof Error && responseLimitErrors.has(error)) throw error;
    await abortRace.throwIfAborted(reader);
    throw error;
  } finally {
    abortRace.dispose();
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

  try {
    return await consumeResponseBody(reader, effectiveLimit, preview, options.signal);
  } finally {
    reader.releaseLock();
  }
}

export async function cancelAuxiliaryResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Auxiliary response cleanup cannot hide the useful upstream outcome.
  }
}
