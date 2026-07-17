import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { NodeHtmlMarkdown } from "node-html-markdown";
import { fetch as undiciFetch, type Dispatcher } from "undici";
import { createProxyAgent, createUrlReaderAgent, ProxyType } from "./proxy.js";
import { logMessage } from "./logging.js";
import { urlCache } from "./cache.js";
import { assertUrlAllowed, isUrlSecurityPolicyDnsError } from "./url-security.js";
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
  type ErrorContext
} from "./error-handler.js";

interface PageMetadata {
  title?: string;
  author?: string;
  publishedDate?: string;
  description?: string;
  siteName?: string;
}

interface PaginationOptions {
  startChar?: number;
  maxLength?: number;
  section?: string;
  paragraphRange?: string;
  readHeadings?: boolean;
  extractMainContent?: boolean;
  extractMetadata?: boolean;
}

type BoundedBodyReadResult =
  | { exceeded: false; text: string; bytesRead: number; hasNulInPrefix: boolean }
  | { exceeded: true; bytesRead: number };

const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;
const DEFAULT_MAX_LENGTH = 8000;
export const DEFAULT_MAX_CONTENT_LENGTH_BYTES = 5 * 1024 * 1024;
const HEAD_TIMEOUT_CAP_MS = 3000;
const BINARY_SNIFF_PREFIX_BYTES = 1024;

type ContentTypeClassification =
  | { kind: "html"; mediaType: string; language: "html" }
  | { kind: "json"; mediaType: string; language: "json" }
  | { kind: "text"; mediaType: string; language: "text" | "yaml" | "toml" | "xml" }
  | { kind: "binary"; mediaType: string | null }
  | { kind: "generic"; mediaType: string | null };

const EXACT_READABLE_CONTENT_TYPES = new Map<string, (mediaType: string) => ContentTypeClassification>([
  ["text/html", (mediaType) => ({ kind: "html", mediaType, language: "html" })],
  ["application/xhtml+xml", (mediaType) => ({ kind: "html", mediaType, language: "html" })],
  ["application/json", (mediaType) => ({ kind: "json", mediaType, language: "json" })],
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
  "application/pdf",
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

export function extractMainContent(html: string, url: string): string | null {
  const { document } = parseHTML(html);
  const reader = new Readability(document);
  const article = reader.parse();
  if (!article?.content) {
    return null;
  }
  return article.content;
}

function getMeta(doc: Document, name: string): string | undefined {
  const el = doc.querySelector(
    `meta[name="${name}"], meta[property="${name}"], meta[itemprop="${name}"]`
  );
  return el?.getAttribute("content")?.trim() || undefined;
}

function firstMeta(doc: Document, names: string[]): string | undefined {
  for (const name of names) {
    const value = getMeta(doc, name);
    if (value) return value;
  }
  return undefined;
}

export function extractMetadata(html: string, url: string): PageMetadata {
  const { document } = parseHTML(html);
  const result: PageMetadata = {};

  const title = firstMeta(document, ["og:title", "twitter:title"])
    || document.querySelector("title")?.textContent?.trim()
    || undefined;
  if (title) result.title = title;

  const author = firstMeta(document, ["author", "article:author", "og:article:author"]);
  if (author) result.author = author;

  const publishedDate = firstMeta(document, ["article:published_time", "og:article:published_time", "date", "pubdate"]);
  if (publishedDate) result.publishedDate = publishedDate;

  const description = firstMeta(document, ["description", "og:description", "twitter:description"]);
  if (description) result.description = description;

  const siteName = getMeta(document, "og:site_name") || undefined;
  if (siteName) result.siteName = siteName;

  return result;
}

function formatMetadataBlock(metadata: PageMetadata): string {
  const lines: string[] = [];
  if (metadata.title) lines.push(`title: ${metadata.title}`);
  if (metadata.author) lines.push(`author: ${metadata.author}`);
  if (metadata.publishedDate) lines.push(`published: ${metadata.publishedDate}`);
  if (metadata.description) lines.push(`description: ${metadata.description}`);
  if (metadata.siteName) lines.push(`site: ${metadata.siteName}`);
  return lines.length > 0 ? `---\n${lines.join("\n")}\n---\n\n` : "";
}

function isTargetedFetch(options: PaginationOptions): boolean {
  return options.readHeadings === true
    || options.section !== undefined
    || options.paragraphRange !== undefined;
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
  } else if (!isTargetedFetch(options) && result.length > DEFAULT_MAX_LENGTH) {
    result = applyCharacterPagination(result, 0, DEFAULT_MAX_LENGTH);
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

  try {
    const requestOptions: RequestInit = {
      ...baseRequestOptions,
      method: "HEAD",
      signal: controller.signal,
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

  const parsed = parseInt(rawValue, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
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
    "Binary, media, archive, and PDF downloads are intentionally not read by web_url_read."
  );
}

function createNulRejectedContentMessage(classification: ContentTypeClassification): string {
  if (classification.kind !== "generic" && classification.mediaType !== null) {
    return (
      `Body was declared ${classification.mediaType} but appears binary (NUL byte in first 1KB); not read. ` +
      "Binary, media, archive, and PDF downloads are intentionally not read by web_url_read."
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
): BoundedBodyReadResult | null {
  if (hasNulInPrefix && abortOnNulInPrefix) {
    return { exceeded: false, text: "", bytesRead, hasNulInPrefix };
  }
  if (bytesRead > maxBytes) {
    return { exceeded: true, bytesRead };
  }
  return null;
}

async function readResponseBodyWithLimit(
  response: Response,
  maxBytes: number,
  abortOnNulInPrefix: boolean = false,
): Promise<BoundedBodyReadResult> {
  if (response.body === null) {
    return { exceeded: false, text: "", bytesRead: 0, hasNulInPrefix: false };
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

  const bodyBytes = concatenateChunks(chunks, bytesRead);
  return { exceeded: false, text: new TextDecoder("utf-8").decode(bodyBytes), bytesRead, hasNulInPrefix };
}

export async function fetchAndConvertToMarkdown(
  mcpServer: McpServer,
  url: string,
  timeoutMs: number = 10000,
  paginationOptions: PaginationOptions = {}
) {
  const startTime = Date.now();
  logMessage(mcpServer, "info", `Fetching URL: ${url}`);

  // Check cache first
  const cachedEntry = urlCache.get(url);
  if (cachedEntry) {
    logMessage(mcpServer, "info", `Using cached content for URL: ${url}`);
    const result = applyPaginationOptions(cachedEntry.markdownContent, paginationOptions);
    const duration = Date.now() - startTime;
    logMessage(mcpServer, "info", `Processed cached URL: ${url} (${result.length} chars in ${duration}ms)`);
    return result;
  }
  
  // Validate URL format
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch (error) {
    logMessage(mcpServer, "error", `Invalid URL format: ${url}`);
    throw createURLFormatError(url);
  }

  assertUrlAllowed(parsedUrl);
  const maxContentLengthBytes = getMaxContentLengthBytes(mcpServer);

  // Create an AbortController instance
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // Prepare base request options with proxy support
    const requestOptions: RequestInit = {
      signal: controller.signal,
      redirect: "manual",
    };

    // Add User-Agent header if configured (URL_READER_USER_AGENT takes priority over USER_AGENT)
    const userAgent = process.env.URL_READER_USER_AGENT || process.env.USER_AGENT;
    if (userAgent) {
      requestOptions.headers = {
        ...requestOptions.headers,
        'User-Agent': userAgent
      };
    }

    let response!: Response;
    let currentUrl = parsedUrl;
    let usedDispatcher = false;
    try {
      for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
        // Add proxy or default dispatcher (includes system CA certs for TLS)
        const proxyAgent = createProxyAgent(currentUrl.toString(), ProxyType.URL_READER);
        const dispatcher = proxyAgent ?? createUrlReaderAgent();
        usedDispatcher = !!dispatcher;
        const currentRequestOptions = {
          ...requestOptions,
        };
        if (dispatcher) {
          (currentRequestOptions as any).dispatcher = dispatcher;
        }

        const contentLength = await checkContentLength(
          mcpServer,
          currentUrl.toString(),
          timeoutMs,
          dispatcher,
          currentRequestOptions,
        );
        if (contentLength !== null && contentLength > maxContentLengthBytes) {
          return createContentTooLargeMessage(contentLength, maxContentLengthBytes);
        }

        // Fetch the URL with the abort signal.
        // Use undici's own fetch so it shares the same internal version as the
        // Agent/ProxyAgent dispatcher — avoids the Node.js bundled-undici vs
        // npm-undici version mismatch that breaks Content-Encoding decompression.
        response = await (undiciFetch as unknown as typeof fetch)(currentUrl.toString(), currentRequestOptions);

        if (!isRedirectResponse(response)) {
          break;
        }

        const location = response.headers.get("location");
        if (!location) {
          break;
        }

        if (redirects === MAX_REDIRECTS) {
          throw createContentError(`Too many redirects while fetching URL: ${url}`, url);
        }

        const nextUrl = new URL(location, currentUrl);
        assertUrlAllowed(nextUrl);
        currentUrl = nextUrl;
      }
    } catch (error: any) {
      if (error.name === 'MCPSearXNGError') {
        throw error;
      }

      if (isUrlSecurityPolicyDnsError(error)) {
        throw createURLSecurityPolicyError(currentUrl.toString());
      }

      const context: ErrorContext = {
        url: currentUrl.toString(),
        proxyAgent: usedDispatcher,
        timeout: timeoutMs
      };
      throw createNetworkError(error, context);
    }

    if (!response.ok) {
      let responseBody: string;
      try {
        const bodyRead = await readResponseBodyWithLimit(response, maxContentLengthBytes);
        responseBody = bodyRead.exceeded
          ? createContentTooLargeMessage(bodyRead.bytesRead, maxContentLengthBytes)
          : bodyRead.text;
      } catch {
        responseBody = '[Could not read response body]';
      }

      const context: ErrorContext = { url };
      throw createServerError(response.status, response.statusText, responseBody, context);
    }

    const contentType = classifyContentType(response.headers.get("content-type"));
    if (contentType.kind === "binary") {
      await cancelResponseBody(response);
      return createUnsupportedContentTypeMessage(contentType);
    }

    // Retrieve readable content
    let rawContent: string;
    let hasNulInPrefix = false;
    try {
      const bodyRead = await readResponseBodyWithLimit(response, maxContentLengthBytes, true);
      if (bodyRead.exceeded) {
        return createContentTooLargeMessage(bodyRead.bytesRead, maxContentLengthBytes);
      }
      rawContent = bodyRead.text;
      hasNulInPrefix = bodyRead.hasNulInPrefix;
    } catch (error: any) {
      throw createContentError(
        `Failed to read website content: ${error.message || 'Unknown error reading content'}`,
        url
      );
    }

    if (hasNulInPrefix) {
      return createNulRejectedContentMessage(contentType);
    }

    if (!rawContent || rawContent.trim().length === 0) {
      throw createContentError("Website returned empty content.", url);
    }

    // Extract metadata and apply Readability for HTML content
    let metadataBlock = "";
    if (contentType.kind === "html") {
      if (paginationOptions.extractMetadata !== false) {
        try {
          const metadata = extractMetadata(rawContent, url);
          metadataBlock = formatMetadataBlock(metadata);
        } catch (metaErr: any) {
          logMessage(mcpServer, "warning", `Metadata extraction failed for ${url}: ${metaErr.message}`);
        }
      }

      if (paginationOptions.extractMainContent !== false) {
        try {
          const extracted = extractMainContent(rawContent, url);
          if (extracted) {
            rawContent = extracted;
            logMessage(mcpServer, "info", `Readability extracted main content for: ${url}`);
          }
        } catch (readabilityErr: any) {
          logMessage(mcpServer, "warning", `Readability failed for ${url} (falling back to full HTML): ${readabilityErr.message}`);
        }
      }
    }

    // Convert readable content to Markdown
    let markdownContent: string;
    if (contentType.kind === "json") {
      markdownContent = renderJsonMarkdown(rawContent);
    } else if (contentType.kind === "text") {
      markdownContent = renderFencedMarkdown(contentType.language, rawContent);
    } else {
      try {
        markdownContent = NodeHtmlMarkdown.translate(rawContent);
      } catch {
        throw createConversionError(url);
      }
    }

    if (!markdownContent || markdownContent.trim().length === 0) {
      logMessage(mcpServer, "warning", `Empty content after conversion: ${url}`);
      // DON'T cache empty/failed conversions - return warning directly
      return createEmptyContentWarning(url);
    }

    // Only cache successful markdown conversion
    urlCache.set(url, rawContent, markdownContent);

    // Apply pagination options
    const result = applyPaginationOptions(markdownContent, paginationOptions);

    // Prepend metadata block after pagination — startChar/maxLength only apply to body
    const finalResult = metadataBlock + result;

    const duration = Date.now() - startTime;
    logMessage(mcpServer, "info", `Successfully fetched and converted URL: ${url} (${finalResult.length} chars in ${duration}ms)`);
    return finalResult;
  } catch (error: any) {
    if (error.name === "AbortError") {
      logMessage(mcpServer, "error", `Timeout fetching URL: ${url} (${timeoutMs}ms)`);
      throw createTimeoutError(timeoutMs, url);
    }
    // Re-throw our enhanced errors
    if (error.name === 'MCPSearXNGError') {
      logMessage(mcpServer, "error", `Error fetching URL: ${url} - ${error.message}`);
      throw error;
    }
    
    // Catch any unexpected errors
    logMessage(mcpServer, "error", `Unexpected error fetching URL: ${url}`, error);
    const context: ErrorContext = { url };
    throw createUnexpectedError(error, context);
  } finally {
    // Clean up the timeout to prevent memory leaks
    clearTimeout(timeoutId);
  }
}
