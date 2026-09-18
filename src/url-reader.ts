import { McpServer } from "@modelcontextprotocol/server";
import { assertSafeOutput } from "./credential-output.js";
import { NodeHtmlMarkdown } from "node-html-markdown";
import { fetch as undiciFetch, type Dispatcher } from "undici";
import { createProxyAgent, createUrlReaderAgent, ProxyType } from "./proxy.js";
import { logMessage } from "./logging.js";
import { urlCache } from "./cache.js";
import { assertUrlAllowed, isUrlSecurityPolicyDnsError } from "./url-security.js";
import { parseStrictInteger } from "./env-int.js";
import {
  acquireBrowserSolverSolution,
  buildBrowserSolverHeaders,
  createBrowserSolverCacheKey,
  resolveBrowserSolverConfigs,
  type BrowserSolverSolution,
} from "./browser-solver.js";
import { browserSolverContentResponse, browserSolverEnvelopeLimit } from "./browser-solver-content.js";
import { extractPdfText, MAX_PDF_BYTES, MAX_PDF_PAGES } from "./pdf-reader.js";
import {
  createURLFormatError,
  createURLSecurityPolicyError,
  createNetworkError,
  createServerError,
  createContentError,
  createConversionError,
  createTimeoutError,
  createEmptyContentWarning,
  createUnexpectedError,
} from "./error-handler.js";

interface PaginationOptions {
  startChar?: number;
  maxLength?: number;
  section?: string;
  paragraphRange?: string;
  readHeadings?: boolean;
}

type BoundedBodyReadResult =
  | { exceeded: false; text: string; bytesRead: number; hasNulInPrefix: boolean }
  | { exceeded: true; bytesRead: number };

type BoundedByteReadResult =
  | { exceeded: false; bytes: Uint8Array; bytesRead: number; hasNulInPrefix: boolean }
  | { exceeded: true; bytesRead: number };

const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;
export const DEFAULT_MAX_CONTENT_LENGTH_BYTES = 5 * 1024 * 1024;
const HEAD_TIMEOUT_CAP_MS = 3000;
const BINARY_SNIFF_PREFIX_BYTES = 1024;

type ContentTypeClassification =
  | { kind: "html"; mediaType: string; language: "html" }
  | { kind: "json"; mediaType: string; language: "json" }
  | { kind: "pdf"; mediaType: "application/pdf" }
  | { kind: "text"; mediaType: string; language: "text" | "yaml" | "toml" | "xml" }
  | { kind: "binary"; mediaType: string | null }
  | { kind: "generic"; mediaType: string | null };

const EXACT_READABLE_CONTENT_TYPES = new Map<string, (mediaType: string) => ContentTypeClassification>([
  ["text/html", (mediaType) => ({ kind: "html", mediaType, language: "html" })],
  ["application/xhtml+xml", (mediaType) => ({ kind: "html", mediaType, language: "html" })],
  ["application/json", (mediaType) => ({ kind: "json", mediaType, language: "json" })],
  ["application/pdf", () => ({ kind: "pdf", mediaType: "application/pdf" })],
  ["application/xml", (mediaType) => ({ kind: "text", mediaType, language: "xml" })],
  ["text/xml", (mediaType) => ({ kind: "text", mediaType, language: "xml" })],
  ["application/yaml", (mediaType) => ({ kind: "text", mediaType, language: "yaml" })],
  ["application/x-yaml", (mediaType) => ({ kind: "text", mediaType, language: "yaml" })],
  ["text/yaml", (mediaType) => ({ kind: "text", mediaType, language: "yaml" })],
  ["text/x-yaml", (mediaType) => ({ kind: "text", mediaType, language: "yaml" })],
  ["application/toml", (mediaType) => ({ kind: "text", mediaType, language: "toml" })],
  ["application/x-toml", (mediaType) => ({ kind: "text", mediaType, language: "toml" })],
  ["text/toml", (mediaType) => ({ kind: "text", mediaType, language: "toml" })],
]);

const EXACT_BINARY_CONTENT_TYPES = new Set([
  "application/octet-stream",
  "binary/octet-stream",
  "application/zip",
  "application/x-zip",
  "application/x-zip-compressed",
  "application/gzip",
  "application/x-gzip",
  "application/x-tar",
  "application/tar",
  "application/x-7z-compressed",
  "application/x-rar-compressed",
  "application/vnd.rar",
  "application/x-bzip",
  "application/x-bzip2",
  "application/x-xz",
  "application/zstd",
]);

function isRedirectResponse(response: Response): boolean {
  return REDIRECT_STATUS_CODES.has(response.status);
}

function applyCharacterPagination(content: string, startChar: number = 0, maxLength?: number): string {
  if (startChar >= content.length) {
    return "";
  }

  const start = Math.max(0, startChar);
  const end = maxLength ? Math.min(content.length, start + maxLength) : content.length;

  return content.slice(start, end);
}

function extractSection(markdownContent: string, sectionHeading: string): string {
  const lines = markdownContent.split('\n');
  const normalizedHeading = sectionHeading.toLowerCase();

  let startIndex = -1;
  let currentLevel = 0;

  // Find the section start — string match avoids RegExp constructor with user input
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^#{1,6}\s/.test(line) && line.toLowerCase().includes(normalizedHeading)) {
      startIndex = i;
      currentLevel = (line.match(/^#+/) || [''])[0].length;
      break;
    }
  }

  if (startIndex === -1) {
    return "";
  }

  // Find the section end (next heading of same or higher level)
  let endIndex = lines.length;
  for (let i = startIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(/^#+/);
    if (match && match[0].length <= currentLevel) {
      endIndex = i;
      break;
    }
  }

  return lines.slice(startIndex, endIndex).join('\n');
}

function extractParagraphRange(markdownContent: string, range: string): string {
  const paragraphs = markdownContent.split('\n\n').filter(p => p.trim().length > 0);

  // Parse range (e.g., "1-5", "3", "10-")
  // eslint-disable-next-line security/detect-unsafe-regex
  const rangeMatch = range.match(/^(\d+)(?:-(\d*))?$/);
  if (!rangeMatch) {
    return "";
  }

  const start = parseInt(rangeMatch[1]) - 1; // Convert to 0-based index
  const endStr = rangeMatch[2];

  if (start < 0 || start >= paragraphs.length) {
    return "";
  }

  if (endStr === undefined) {
    // Single paragraph (e.g., "3")
    return paragraphs[start] || "";
  } else if (endStr === "") {
    // Range to end (e.g., "10-")
    return paragraphs.slice(start).join('\n\n');
  } else {
    // Specific range (e.g., "1-5")
    const end = parseInt(endStr);
    return paragraphs.slice(start, end).join('\n\n');
  }
}

function extractHeadings(markdownContent: string): string {
  const lines = markdownContent.split('\n');
  const headings = lines.filter(line => /^#{1,6}\s/.test(line));

  if (headings.length === 0) {
    return "No headings found in the content.";
  }

  return headings.join('\n');
}

function applyPaginationOptions(markdownContent: string, options: PaginationOptions): string {
  let result = markdownContent;

  // Apply heading extraction first if requested
  if (options.readHeadings) {
    return extractHeadings(result);
  }

  // Apply section extraction
  if (options.section) {
    result = extractSection(result, options.section);
    if (result === "") {
      return `Section "${options.section}" not found in the content.`;
    }
  }

  // Apply paragraph range filtering
  if (options.paragraphRange) {
    result = extractParagraphRange(result, options.paragraphRange);
    if (result === "") {
      return `Paragraph range "${options.paragraphRange}" is invalid or out of bounds.`;
    }
  }

  // Apply character-based pagination last
  if (options.startChar !== undefined || options.maxLength !== undefined) {
    result = applyCharacterPagination(result, options.startChar, options.maxLength);
  }

  return result;
}

export async function checkContentLength(
  mcpServer: McpServer,
  url: string,
  timeoutMs: number,
  dispatcher?: Dispatcher,
  baseRequestOptions: RequestInit = {},
): Promise<number | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), Math.min(timeoutMs, HEAD_TIMEOUT_CAP_MS));
  const callerSignal = baseRequestOptions.signal ?? undefined;
  const signal = callerSignal
    ? AbortSignal.any([callerSignal, controller.signal])
    : controller.signal;

  try {
    const requestOptions: RequestInit = {
      ...baseRequestOptions,
      method: "HEAD",
      signal,
      redirect: "manual",
    };

    if (dispatcher) {
      (requestOptions as any).dispatcher = dispatcher;
    }

    const response = await (undiciFetch as unknown as typeof fetch)(url, requestOptions);
    const contentLength = response.headers.get("content-length");
    if (!contentLength) {
      return null;
    }

    const parsed = parseInt(contentLength, 10);
    return Number.isNaN(parsed) || parsed < 0 ? null : parsed;
  } catch (error: any) {
    if (callerSignal?.aborted) {
      throw callerSignal.reason ?? new DOMException("The operation was aborted.", "AbortError");
    }
    if (isUrlSecurityPolicyDnsError(error)) {
      throw createURLSecurityPolicyError(url);
    }

    logMessage(mcpServer, "warning", `HEAD check failed (proceeding with GET): ${error.message}`);
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

function getMaxContentLengthBytes(mcpServer: McpServer): number {
  const rawValue = process.env.URL_READ_MAX_CONTENT_LENGTH_BYTES;
  if (rawValue === undefined || rawValue.trim() === "") {
    return DEFAULT_MAX_CONTENT_LENGTH_BYTES;
  }

  const parsed = parseStrictInteger(rawValue);
  if (parsed === undefined || parsed <= 0) {
    logMessage(
      mcpServer,
      "warning",
      `Ignoring invalid URL_READ_MAX_CONTENT_LENGTH_BYTES="${rawValue}". Expected a positive integer; using default ${DEFAULT_MAX_CONTENT_LENGTH_BYTES}.`,
    );
    return DEFAULT_MAX_CONTENT_LENGTH_BYTES;
  }

  return parsed;
}

function formatByteSize(bytes: number): string {
  // Pick the unit by magnitude, and keep the exact byte count so sizes near
  // the limit never read as a contradiction (e.g. "5.00 MB exceeds 5.00 MB").
  if (bytes < 1024) {
    return `${bytes} bytes`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB (${bytes} bytes)`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB (${bytes} bytes)`;
}

function createContentTooLargeMessage(contentLength: number, maxBytes: number): string {
  return (
    `Content too large: ${formatByteSize(contentLength)} exceeds the ${formatByteSize(maxBytes)} limit. ` +
    `readHeadings and section only trim the returned output — they cannot fetch a page over the size cap. ` +
    `To read larger pages, raise URL_READ_MAX_CONTENT_LENGTH_BYTES.`
  );
}

function createPdfTextTooLargeMessage(textBytes: number, maxBytes: number): string {
  return (
    `Extracted PDF text exceeds the safe byte limit: ${formatByteSize(textBytes)} ` +
    `exceeds ${formatByteSize(maxBytes)}.`
  );
}

function createPdfInputTooLargeMessage(
  contentLength: number,
  effectiveLimit: number,
  configuredLimit: number,
): string {
  if (configuredLimit < MAX_PDF_BYTES) {
    return createContentTooLargeMessage(contentLength, effectiveLimit);
  }
  return (
    `Content too large: ${formatByteSize(contentLength)} exceeds the ${formatByteSize(effectiveLimit)} limit. ` +
    `This is the fixed PDF input ceiling and cannot be raised with URL_READ_MAX_CONTENT_LENGTH_BYTES.`
  );
}

function normalizeMediaType(contentType: string | null): string | null {
  if (!contentType) {
    return null;
  }

  const mediaType = contentType.split(";")[0].trim().toLowerCase();
  return mediaType === "" ? null : mediaType;
}

function isBinaryMediaType(mediaType: string): boolean {
  if (
    mediaType.startsWith("image/") ||
    mediaType.startsWith("audio/") ||
    mediaType.startsWith("video/") ||
    mediaType.startsWith("font/")
  ) {
    return true;
  }

  return EXACT_BINARY_CONTENT_TYPES.has(mediaType);
}

function classifyContentType(contentType: string | null): ContentTypeClassification {
  const mediaType = normalizeMediaType(contentType);
  if (mediaType === null) {
    return { kind: "generic", mediaType };
  }

  const exactReadable = EXACT_READABLE_CONTENT_TYPES.get(mediaType);
  if (exactReadable) {
    return exactReadable(mediaType);
  }

  if (mediaType.endsWith("+json")) {
    return { kind: "json", mediaType, language: "json" };
  } else if (isBinaryMediaType(mediaType)) {
    return { kind: "binary", mediaType };
  } else if (mediaType.endsWith("+xml")) {
    return { kind: "text", mediaType, language: "xml" };
  } else if (mediaType.startsWith("text/")) {
    return { kind: "text", mediaType, language: "text" };
  }

  return { kind: "generic", mediaType };
}

function createUnsupportedContentTypeMessage(classification: ContentTypeClassification, reason?: string): string {
  const contentType = classification.mediaType ?? "missing";
  const reasonText = reason ? ` ${reason}` : "";
  return (
    `Unsupported content type: ${contentType}.${reasonText} ` +
    "Binary, media, and archive downloads are intentionally not read by web_url_read."
  );
}

function createNulRejectedContentMessage(classification: ContentTypeClassification): string {
  if (classification.kind !== "generic" && classification.mediaType !== null) {
    return (
      `Body was declared ${classification.mediaType} but appears binary (NUL byte in first 1KB); not read. ` +
      "Binary, media, and archive downloads are intentionally not read by web_url_read."
    );
  }

  return createUnsupportedContentTypeMessage(
    classification,
    `Body appears binary: NUL byte found in the first ${BINARY_SNIFF_PREFIX_BYTES} bytes.`,
  );
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Best-effort cancellation: returning the unsupported hint is more useful than surfacing cancellation noise.
  }
}

function getLongestBacktickRun(text: string): number {
  let longestRun = 0;
  let currentRun = 0;

  for (const char of text) {
    if (char === "`") {
      currentRun++;
      longestRun = Math.max(longestRun, currentRun);
    } else {
      currentRun = 0;
    }
  }

  return longestRun;
}

function renderFencedMarkdown(language: string, text: string): string {
  const fence = "`".repeat(Math.max(3, getLongestBacktickRun(text) + 1));
  return `${fence}${language}\n${text}\n${fence}`;
}

function renderJsonMarkdown(text: string): string {
  try {
    const parsed = JSON.parse(text);
    return renderFencedMarkdown("json", JSON.stringify(parsed, null, 2));
  } catch {
    return `Note: Response declared JSON but could not be parsed.\n\n${renderFencedMarkdown("text", text)}`;
  }
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

function scanPrefixForNul(value: Uint8Array, prefixBytesChecked: number): { hasNul: boolean; prefixBytesChecked: number } {
  const remainingPrefixBytes = BINARY_SNIFF_PREFIX_BYTES - prefixBytesChecked;
  const bytesToCheck = Math.min(value.byteLength, remainingPrefixBytes);
  if (bytesToCheck <= 0) {
    return { hasNul: false, prefixBytesChecked };
  }

  return {
    hasNul: value.subarray(0, bytesToCheck).includes(0),
    prefixBytesChecked: prefixBytesChecked + bytesToCheck,
  };
}

function evaluateChunkLimits(
  bytesRead: number,
  maxBytes: number,
  hasNulInPrefix: boolean,
  abortOnNulInPrefix: boolean,
): BoundedByteReadResult | null {
  if (hasNulInPrefix && abortOnNulInPrefix) {
    return { exceeded: false, bytes: new Uint8Array(), bytesRead, hasNulInPrefix };
  }
  if (bytesRead > maxBytes) {
    return { exceeded: true, bytesRead };
  }
  return null;
}

async function readResponseBytesWithLimit(
  response: Response,
  maxBytes: number,
  abortOnNulInPrefix: boolean = false,
): Promise<BoundedByteReadResult> {
  if (response.body === null) {
    return { exceeded: false, bytes: new Uint8Array(), bytesRead: 0, hasNulInPrefix: false };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytesRead = 0;
  let prefixBytesChecked = 0;
  let hasNulInPrefix = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }

      const nulScan = scanPrefixForNul(value, prefixBytesChecked);
      hasNulInPrefix = hasNulInPrefix || nulScan.hasNul;
      prefixBytesChecked = nulScan.prefixBytesChecked;

      bytesRead += value.byteLength;
      const limitResult = evaluateChunkLimits(bytesRead, maxBytes, hasNulInPrefix, abortOnNulInPrefix);
      if (limitResult) {
        await reader.cancel();
        return limitResult;
      }

      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return {
    exceeded: false,
    bytes: concatenateChunks(chunks, bytesRead),
    bytesRead,
    hasNulInPrefix,
  };
}

async function readResponseBodyWithLimit(
  response: Response,
  maxBytes: number,
  abortOnNulInPrefix: boolean = false,
): Promise<BoundedBodyReadResult> {
  const result = await readResponseBytesWithLimit(response, maxBytes, abortOnNulInPrefix);
  if (result.exceeded) {
    return result;
  }
  return {
    exceeded: false,
    text: new TextDecoder("utf-8").decode(result.bytes),
    bytesRead: result.bytesRead,
    hasNulInPrefix: result.hasNulInPrefix,
  };
}

function hasPdfSignature(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 5
    && bytes[0] === 0x25
    && bytes[1] === 0x50
    && bytes[2] === 0x44
    && bytes[3] === 0x46
    && bytes[4] === 0x2d;
}

class RetryableSolverReadError extends Error {
  constructor(readonly failure: Error) { super("Browser solver read may use the next provider."); }
}

function isRetryableSolverStatus(status: number, headers?: Headers): boolean {
  // Respect rate limiting and any explicit retry delay; never switch providers
  // to circumvent Retry-After. Other persistent client errors stop the chain.
  return !headers?.has("retry-after")
    && (status === 403 || status === 408 || status === 500 || status === 502 || status === 503 || status === 504);
}

function isRetryableReplayError(error: any, timedOut: boolean): boolean {
  return timedOut || ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT']
    .includes(error?.cause?.code ?? error?.code);
}

export async function fetchAndConvertToMarkdown(
  mcpServer: McpServer,
  url: string,
  timeoutMs: number = 10000,
  paginationOptions: PaginationOptions = {},
  signal?: AbortSignal,
) {
  const startTime = Date.now();
  logMessage(mcpServer, "info", `Fetching URL: ${url}`);

  // Validate URL format
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch (error) {
    logMessage(mcpServer, "error", `Invalid URL format: ${url}`);
    throw createURLFormatError(url);
  }

  assertUrlAllowed(parsedUrl);
  const browserSolverConfigs = resolveBrowserSolverConfigs(mcpServer);
  const configuredCacheKeys = browserSolverConfigs.length > 0
    ? browserSolverConfigs.map(({ provider }) => createBrowserSolverCacheKey(provider, url))
    : [url];

  for (const configuredCacheKey of configuredCacheKeys) {
    const cachedEntry = urlCache.get(configuredCacheKey);
    if (cachedEntry) {
      assertSafeOutput(cachedEntry.markdownContent);
      logMessage(mcpServer, "info", `Using cached content for URL: ${url}`);
      const result = applyPaginationOptions(cachedEntry.markdownContent, paginationOptions);
      const duration = Date.now() - startTime;
      logMessage(mcpServer, "info", `Processed cached URL: ${url} (${result.length} chars in ${duration}ms)`);
      return result;
    }
  }

  const maxContentLengthBytes = getMaxContentLengthBytes(mcpServer);

  if (browserSolverConfigs.length > 0) {
    const preflightProxyAgent = createProxyAgent(parsedUrl.toString(), ProxyType.URL_READER);
    const preflightDispatcher = preflightProxyAgent ?? createUrlReaderAgent();
    const preflightHeaders: Record<string, string> = {};
    const configuredUserAgent = process.env.URL_READER_USER_AGENT || process.env.USER_AGENT;
    if (configuredUserAgent) {
      preflightHeaders["User-Agent"] = configuredUserAgent;
    }
    const contentLength = await checkContentLength(
      mcpServer,
      parsedUrl.toString(),
      timeoutMs,
      preflightDispatcher,
      {
        redirect: "manual",
        headers: preflightHeaders,
        signal,
      },
    );
    if (contentLength !== null && contentLength > maxContentLengthBytes) {
      return createContentTooLargeMessage(contentLength, maxContentLengthBytes);
    }

    let retryFailure: Error | undefined;
    let wasBusy = false;
    for (const config of browserSolverConfigs) {
      signal?.throwIfAborted();
      const boundedConfig = { ...config, maxResponseBytes: Math.min(config.maxResponseBytes, browserSolverEnvelopeLimit(maxContentLengthBytes)) };
      const acquisition = await acquireBrowserSolverSolution(mcpServer, boundedConfig, parsedUrl, signal, false, true);
      if (acquisition.kind === "fallback") {
        wasBusy ||= acquisition.reason === "busy";
        logMessage(mcpServer, "warning", "Browser solver acquisition did not produce a solution.",
          { provider: config.provider, stage: "acquisition", classification: acquisition.reason });
        continue;
      }
      const solution = acquisition.solution;
      try {
        if (solution.status < 200 || solution.status >= 300) {
          const failure = createServerError(solution.status, "", "", { url });
          const retryAfter = Object.keys(solution.headers ?? {}).some(name => name.toLowerCase() === "retry-after");
          if (!retryAfter && isRetryableSolverStatus(solution.status)) throw new RetryableSolverReadError(failure);
          throw failure;
        }
        const renderedResponse = browserSolverContentResponse(config.provider, solution, maxContentLengthBytes);
        logMessage(mcpServer, "debug", "Reading browser solver result.",
          { provider: config.provider, stage: renderedResponse ? "content" : "replay" });
        return await convertUrlAttempt(mcpServer, parsedUrl, timeoutMs, paginationOptions, signal, {
          browserSolverSolution: solution, renderedResponse,
          cacheKey: createBrowserSolverCacheKey(config.provider, url),
          shouldCacheResult: true, skipHead: true, maxContentLengthBytes,
        });
      } catch (error) {
        signal?.throwIfAborted();
        if (!(error instanceof RetryableSolverReadError)) throw error;
        retryFailure = error.failure;
        logMessage(mcpServer, "warning", "Browser solver read did not complete.",
          { provider: config.provider, stage: "read", classification: "retryable" });
      }
    }
    if (retryFailure) throw retryFailure;
    if (wasBusy) throw createContentError("Browser solver is busy; try again later.", url);
  }

  return await convertUrlAttempt(mcpServer, parsedUrl, timeoutMs, paginationOptions, signal, {
    cacheKey: url, shouldCacheResult: browserSolverConfigs.length === 0,
    skipHead: browserSolverConfigs.length > 0, maxContentLengthBytes,
  });
}

interface UrlReadAttemptOptions {
  browserSolverSolution?: BrowserSolverSolution;
  renderedResponse?: Response | null;
  cacheKey: string;
  shouldCacheResult: boolean;
  skipHead: boolean;
  maxContentLengthBytes: number;
}

interface ReadAttempt {
  mcpServer: McpServer;
  parsedUrl: URL;
  url: string;
  timeoutMs: number;
  paginationOptions: PaginationOptions;
  signal?: AbortSignal;
  options: UrlReadAttemptOptions;
  started: number;
  controller: AbortController;
  requestSignal: AbortSignal;
  timeoutId: ReturnType<typeof setTimeout>;
}

type ConvertedContent = { kind: "markdown" | "message"; text: string };

async function convertUrlAttempt(
  mcpServer: McpServer, parsedUrl: URL, timeoutMs: number,
  paginationOptions: PaginationOptions, signal: AbortSignal | undefined,
  options: UrlReadAttemptOptions,
): Promise<string> {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const attempt: ReadAttempt = {
    mcpServer, parsedUrl, url: parsedUrl.href, timeoutMs, paginationOptions, signal, options,
    started: Date.now(), controller,
    requestSignal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
    timeoutId: setTimeout(() => controller.abort(), timeoutMs),
  };
  try {
    const response = options.renderedResponse ?? await fetchReplayResponse(attempt);
    if (typeof response === "string") return response;
    await assertSuccessfulResponse(attempt, response);
    return await completeConversion(attempt, await convertResponse(attempt, response));
  } catch (error: any) {
    throwAttemptError(attempt, error);
  } finally {
    clearTimeout(attempt.timeoutId);
  }
}

function targetRequestOptions(attempt: ReadAttempt, url: URL): RequestInit {
  const userAgent = process.env.URL_READER_USER_AGENT || process.env.USER_AGENT;
  const directHeaders: Record<string, string> = userAgent ? { "User-Agent": userAgent } : {};
  const headers = attempt.options.browserSolverSolution
    ? buildBrowserSolverHeaders(attempt.options.browserSolverSolution, url) : directHeaders;
  const request: RequestInit = { signal: attempt.requestSignal, redirect: "manual", headers };
  (request as any).dispatcher = createProxyAgent(url.href, ProxyType.URL_READER) ?? createUrlReaderAgent();
  return request;
}

async function replaySizeMessage(attempt: ReadAttempt, url: URL, request: RequestInit): Promise<string | null> {
  if (attempt.options.skipHead) return null;
  const length = await checkContentLength(attempt.mcpServer, url.href, attempt.timeoutMs,
    (request as any).dispatcher, request);
  return length !== null && length > attempt.options.maxContentLengthBytes
    ? createContentTooLargeMessage(length, attempt.options.maxContentLengthBytes) : null;
}

function redirectTarget(response: Response, current: URL, count: number): URL | null {
  if (!isRedirectResponse(response)) return null;
  const location = response.headers.get("location");
  if (!location) return null;
  if (count === MAX_REDIRECTS) throw createContentError("Too many redirects while fetching URL.", current.href);
  const next = new URL(location, current);
  assertUrlAllowed(next);
  return next;
}

async function fetchReplayResponse(attempt: ReadAttempt): Promise<Response | string> {
  let current = attempt.parsedUrl;
  try {
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
      const request = targetRequestOptions(attempt, current);
      const sizeMessage = await replaySizeMessage(attempt, current, request);
      if (sizeMessage) return sizeMessage;
      const response = await (undiciFetch as unknown as typeof fetch)(current.href, request);
      const next = redirectTarget(response, current, redirects);
      if (!next) return response;
      current = next;
    }
    throw createContentError("Too many redirects while fetching URL.", attempt.url);
  } catch (error: any) {
    if (error.name === "MCPSearXNGError") throw error;
    if (isUrlSecurityPolicyDnsError(error)) throw createURLSecurityPolicyError(current.href);
    throwReplayError(attempt, error, current.href);
  }
}

function throwReplayError(attempt: ReadAttempt, error: any, url = attempt.url): never {
  const failure = createNetworkError(error, { url, proxyAgent: true, timeout: attempt.timeoutMs });
  if (attempt.options.browserSolverSolution && !attempt.signal?.aborted
      && isRetryableReplayError(error, attempt.controller.signal.aborted)) {
    throw new RetryableSolverReadError(failure);
  }
  throw failure;
}

async function assertSuccessfulResponse(attempt: ReadAttempt, response: Response): Promise<void> {
  if (response.ok) return;
  if (attempt.options.browserSolverSolution && isRetryableSolverStatus(response.status, response.headers)) {
    await cancelResponseBody(response);
    throw new RetryableSolverReadError(createServerError(response.status, "", "", { url: attempt.url }));
  }
  let body = "[Could not read response body]";
  try {
    const read = await readResponseBodyWithLimit(response, attempt.options.maxContentLengthBytes);
    body = read.exceeded ? createContentTooLargeMessage(read.bytesRead, attempt.options.maxContentLengthBytes) : read.text;
  } catch { /* Preserve terminal HTTP status even if its error body stalls. */ }
  throw createServerError(response.status, response.statusText, body, { url: attempt.url });
}

async function convertResponse(attempt: ReadAttempt, response: Response): Promise<ConvertedContent> {
  const type = classifyContentType(response.headers.get("content-type"));
  if (type.kind === "binary") {
    await cancelResponseBody(response);
    return { kind: "message", text: createUnsupportedContentTypeMessage(type) };
  }
  return type.kind === "pdf" ? await convertPdfResponse(attempt, response)
    : await convertTextResponse(attempt, response, type);
}

async function readPdfBody(attempt: ReadAttempt, response: Response, limit: number): Promise<BoundedByteReadResult> {
  try { return await readResponseBytesWithLimit(response, limit); }
  catch (error: any) {
    if (attempt.options.browserSolverSolution) throwReplayError(attempt, error);
    if (error?.name === "AbortError") throw error;
    throw createContentError(`Failed to read PDF content: ${error.message || "Unknown error reading content"}`, attempt.url);
  }
}

const PDF_RESULT_MESSAGES = new Map<string, string>([
  ["no_text", "No extractable text (likely a scanned/image PDF; OCR is not supported)."],
  ["password_protected", "Password-protected PDF cannot be read."],
  ["parse_error", "Unable to extract text from PDF."],
  ["timeout", "PDF text extraction timed out."],
  ["busy", "PDF text extraction is busy; try again later."],
  ["external_fetch_attempt", "PDF attempted an external resource fetch and was blocked."],
  ["worker_failure", "PDF text extraction worker failed."],
]);

function pdfExtractionContent(result: Awaited<ReturnType<typeof extractPdfText>>, limit: number): ConvertedContent {
  if (result.kind === "text") return { kind: "markdown", text: renderFencedMarkdown("text", result.text) };
  if (result.kind === "too_many_pages") return {
    kind: "message", text: `PDF has too many pages to extract safely (observed: ${result.totalPages}; limit: ${MAX_PDF_PAGES}).`,
  };
  if (result.kind === "text_too_large") return { kind: "message", text: createPdfTextTooLargeMessage(result.bytes, limit) };
  return { kind: "message", text: PDF_RESULT_MESSAGES.get(result.kind)! };
}

async function convertPdfResponse(attempt: ReadAttempt, response: Response): Promise<ConvertedContent> {
  const configuredLimit = attempt.options.maxContentLengthBytes;
  const limit = Math.min(configuredLimit, MAX_PDF_BYTES);
  const read = await readPdfBody(attempt, response, limit);
  if (read.exceeded) return { kind: "message", text: createPdfInputTooLargeMessage(read.bytesRead, limit, configuredLimit) };
  clearTimeout(attempt.timeoutId);
  if (!hasPdfSignature(read.bytes)) return { kind: "message", text: "Response declared application/pdf but did not contain a PDF document." };
  return pdfExtractionContent(await extractPdfText(read.bytes, limit, { signal: attempt.signal }), limit);
}

async function readTextBody(attempt: ReadAttempt, response: Response): Promise<BoundedBodyReadResult> {
  try { return await readResponseBodyWithLimit(response, attempt.options.maxContentLengthBytes, true); }
  catch (error: any) {
    if (attempt.options.browserSolverSolution) throwReplayError(attempt, error);
    throw createContentError(`Failed to read website content: ${error.message || "Unknown error reading content"}`, attempt.url);
  }
}

function convertText(text: string, type: ContentTypeClassification, url: string): string {
  assertSafeOutput(text);
  if (type.kind === "json") return renderJsonMarkdown(text);
  if (type.kind === "text") return renderFencedMarkdown(type.language, text);
  try { return NodeHtmlMarkdown.translate(text); }
  catch { throw createConversionError(url); }
}

async function convertTextResponse(attempt: ReadAttempt, response: Response, type: ContentTypeClassification): Promise<ConvertedContent> {
  const read = await readTextBody(attempt, response);
  if (read.exceeded) return { kind: "message", text: createContentTooLargeMessage(read.bytesRead, attempt.options.maxContentLengthBytes) };
  if (read.hasNulInPrefix) return { kind: "message", text: createNulRejectedContentMessage(type) };
  if (!read.text.trim()) throw createContentError("Website returned empty content.", attempt.url);
  return { kind: "markdown", text: convertText(read.text, type, attempt.url) };
}

async function completeConversion(attempt: ReadAttempt, converted: ConvertedContent): Promise<string> {
  if (converted.kind === "message") return converted.text;
  if (!converted.text.trim()) return await completeEmptyConversion(attempt);
  attempt.signal?.throwIfAborted();
  assertSafeOutput(converted.text);
  if (attempt.options.shouldCacheResult) urlCache.set(attempt.options.cacheKey, converted.text);
  const result = applyPaginationOptions(converted.text, attempt.paginationOptions);
  logMessage(attempt.mcpServer, "info", `Successfully fetched and converted URL: ${attempt.url} (${result.length} chars in ${Date.now() - attempt.started}ms)`);
  return result;
}

async function completeEmptyConversion(attempt: ReadAttempt): Promise<string> {
  if (attempt.options.renderedResponse) {
    const remaining = attempt.timeoutMs - (Date.now() - attempt.started);
    if (remaining <= 0) throw new RetryableSolverReadError(createTimeoutError(attempt.timeoutMs, attempt.url));
    clearTimeout(attempt.timeoutId);
    return await convertUrlAttempt(attempt.mcpServer, attempt.parsedUrl, remaining,
      attempt.paginationOptions, attempt.signal, { ...attempt.options, renderedResponse: null });
  }
  logMessage(attempt.mcpServer, "warning", `Empty content after conversion: ${attempt.url}`);
  return createEmptyContentWarning(attempt.url);
}

function throwAttemptError(attempt: ReadAttempt, error: any): never {
  attempt.signal?.throwIfAborted();
  if (error instanceof RetryableSolverReadError) throw error;
  if (error.name === "AbortError") throw createTimeoutError(attempt.timeoutMs, attempt.url);
  if (error.name === "MCPSearXNGError") {
    logMessage(attempt.mcpServer, "error", `Error fetching URL: ${attempt.url} - ${error.message}`);
    throw error;
  }
  logMessage(attempt.mcpServer, "error", `Unexpected error fetching URL: ${attempt.url}`, error);
  throw createUnexpectedError(error, { url: attempt.url });
}
