import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { NodeHtmlMarkdown } from "node-html-markdown";
import { createProxyAgent } from "./proxy.js";
import { logMessage } from "./logging.js";
import { urlCache } from "./cache.js";
import {
  createURLFormatError,
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
  max_length?: number;
  section?: string;
  paragraphRange?: string;
  readHeadings?: boolean;
}

function applyCharacterPagination(content: string, startChar: number = 0, max_length?: number): string {
  if (startChar >= content.length) {
    return "";
  }

  const start = Math.max(0, startChar);
  const end = max_length ? Math.min(content.length, start + max_length) : content.length;

  return content.slice(start, end);
}

function extractSection(markdownContent: string, sectionHeading: string): string {
  const lines = markdownContent.split('\n');
  const sectionRegex = new RegExp(`^#{1,6}\s*.*${sectionHeading}.*$`, 'i');

  let startIndex = -1;
  let currentLevel = 0;

  // Find the section start
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (sectionRegex.test(line)) {
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
  if (options.startChar !== undefined || options.max_length !== undefined) {
    result = applyCharacterPagination(result, options.startChar, options.max_length);
  }

  return result;
}

export async function fetchAndConvertToMarkdown(
  server: Server,
  url: string,
  timeoutMs: number = 10000,
  paginationOptions: PaginationOptions = {}
) {
  const startTime = Date.now();
  logMessage(server, "info", `Fetching URL: ${url}`);

  // Check cache first
  const cachedEntry = urlCache.get(url);
  if (cachedEntry) {
    logMessage(server, "info", `Using cached content for URL: ${url}`);
    const result = applyPaginationOptions(cachedEntry.markdownContent, paginationOptions);
    const duration = Date.now() - startTime;
    logMessage(server, "info", `Processed cached URL: ${url} (${result.length} chars in ${duration}ms)`);
    return result;
  }
  
  // Validate URL format
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch (error) {
    logMessage(server, "error", `Invalid URL format: ${url}`);
    throw createURLFormatError(url);
  }

  // Create an AbortController instance
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // Prepare request options with proxy support
    const requestOptions: RequestInit = {
      signal: controller.signal,
    };

    // Add proxy dispatcher if proxy is configured
    // Node.js fetch uses 'dispatcher' option for proxy, not 'agent'
    const proxyAgent = createProxyAgent(url);
    if (proxyAgent) {
      (requestOptions as any).dispatcher = proxyAgent;
    }

    let response: Response;
    try {
      // Fetch the URL with the abort signal
      response = await fetch(url, requestOptions);
    } catch (error: any) {
      const context: ErrorContext = {
        url,
        proxyAgent: !!proxyAgent,
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
      logMessage(server, "warning", `Empty content after conversion: ${url}`);
      // DON'T cache empty/failed conversions - return warning directly
      return createEmptyContentWarning(url, htmlContent.length, htmlContent);
    }

    // Only cache successful markdown conversion
    urlCache.set(url, htmlContent, markdownContent);

    // Apply pagination options
    const result = applyPaginationOptions(markdownContent, paginationOptions);

    const duration = Date.now() - startTime;
    logMessage(server, "info", `Successfully fetched and converted URL: ${url} (${result.length} chars in ${duration}ms)`);
    return result;
  } catch (error: any) {
    if (error.name === "AbortError") {
      logMessage(server, "error", `Timeout fetching URL: ${url} (${timeoutMs}ms)`);
      throw createTimeoutError(timeoutMs, url);
    }
    // Re-throw our enhanced errors
    if (error.name === 'MCPSearXNGError') {
      logMessage(server, "error", `Error fetching URL: ${url} - ${error.message}`);
      throw error;
    }
    
    // Catch any unexpected errors
    logMessage(server, "error", `Unexpected error fetching URL: ${url}`, error);
    const context: ErrorContext = { url };
    throw createUnexpectedError(error, context);
  } finally {
    // Clean up the timeout to prevent memory leaks
    clearTimeout(timeoutId);
  }
}
