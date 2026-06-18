import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
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

interface PaginationOptions {
  startChar?: number;
  maxLength?: number;
  section?: string;
  paragraphRange?: string;
  readHeadings?: boolean;
}

const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;
export const DEFAULT_MAX_CONTENT_LENGTH_BYTES = 5 * 1024 * 1024;
const HEAD_TIMEOUT_CAP_MS = 3000;

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

function createContentTooLargeMessage(contentLength: number, maxBytes: number): string {
  const sizeMB = (contentLength / (1024 * 1024)).toFixed(1);
  const limitMB = (maxBytes / (1024 * 1024)).toFixed(1);
  return (
    `Content too large: server reports Content-Length of ${sizeMB} MB (limit: ${limitMB} MB). ` +
    `Try using readHeadings or section to fetch only the relevant parts.`
  );
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
        responseBody = await response.text();
      } catch {
        responseBody = '[Could not read response body]';
      }

      const context: ErrorContext = { url };
      throw createServerError(response.status, response.statusText, responseBody, context);
    }

    // Retrieve HTML content
    let htmlContent: string;
    try {
      htmlContent = await response.text();
    } catch (error: any) {
      throw createContentError(
        `Failed to read website content: ${error.message || 'Unknown error reading content'}`,
        url
      );
    }

    if (!htmlContent || htmlContent.trim().length === 0) {
      throw createContentError("Website returned empty content.", url);
    }

    // Convert HTML to Markdown
    let markdownContent: string;
    try {
      markdownContent = NodeHtmlMarkdown.translate(htmlContent);
    } catch (error: any) {
      throw createConversionError(error, url, htmlContent);
    }

    if (!markdownContent || markdownContent.trim().length === 0) {
      logMessage(mcpServer, "warning", `Empty content after conversion: ${url}`);
      // DON'T cache empty/failed conversions - return warning directly
      return createEmptyContentWarning(url, htmlContent.length, htmlContent);
    }

    // Only cache successful markdown conversion
    urlCache.set(url, htmlContent, markdownContent);

    // Apply pagination options
    const result = applyPaginationOptions(markdownContent, paginationOptions);

    const duration = Date.now() - startTime;
    logMessage(mcpServer, "info", `Successfully fetched and converted URL: ${url} (${result.length} chars in ${duration}ms)`);
    return result;
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
