import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isIP, type LookupFunction } from "node:net";
import { lookup as dnsLookup } from "node:dns";
import { NodeHtmlMarkdown } from "node-html-markdown";
import { fetch as undiciFetch } from "undici";
import { Agent } from "undici";
import { createProxyAgent, createDefaultAgent, ProxyType } from "./proxy.js";
import { logMessage } from "./logging.js";
import { urlCache } from "./cache.js";
import { getHttpSecurityConfig } from "./http-security.js";
import { getConnectOptions } from "./tls-config.js";
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

function isPrivateHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase().replace(/\.+$/, "");
  return lower === "localhost" || lower.endsWith(".localhost");
}

function isPrivateIpv4(hostname: string): boolean {
  if (isIP(hostname) !== 4) {
    return false;
  }

  return (
    hostname.startsWith("10.") ||
    hostname.startsWith("127.") ||
    hostname.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname) ||
    hostname.startsWith("169.254.")
  );
}

function isPrivateIPv6(hostname: string): boolean {
  // url.hostname wraps IPv6 in brackets (e.g. "[::1]") — strip them first
  const addr = (hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname
  ).toLowerCase();

  if (isIP(addr) !== 6) return false;

  if (addr === "::1") return true;                        // loopback
  if (addr === "::") return true;                         // unspecified
  if (/^f[cd]/i.test(addr)) return true;                 // ULA fc00::/7
  if (/^fe[89ab][0-9a-f]:/i.test(addr)) return true;    // link-local fe80::/10

  // IPv4-mapped ::ffff:<ipv4> — delegate to the IPv4 check
  const mapped = addr.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) return isPrivateIpv4(mapped[1]);

  return false;
}

function isPrivateAddress(address: string): boolean {
  return isPrivateIpv4(address) || isPrivateIPv6(address);
}

function assertUrlAllowed(url: URL): void {
  const security = getHttpSecurityConfig();
  if (!security.harden || security.allowPrivateUrls) {
    return;
  }

  if (isPrivateHostname(url.hostname) || isPrivateIpv4(url.hostname) || isPrivateIPv6(url.hostname)) {
    throw createURLSecurityPolicyError(url.toString());
  }
}

/**
 * Custom DNS lookup that rejects resolved addresses pointing to private/loopback
 * ranges. This prevents SSRF via DNS rebinding, where an attacker-controlled
 * hostname initially resolves to a public IP (passing assertUrlAllowed) but
 * later resolves to 127.0.0.1, 169.254.169.254, etc. when the actual socket
 * connection is opened.
 *
 * By passing this as the socket `lookup` option, the address checked here is
 * the exact address the socket will connect to — eliminating the TOCTOU window
 * between a pre-flight DNS resolution and the connect() call.
 */
const ssrfGuardedLookup: LookupFunction = (hostname, options, callback) => {
  // node:net's LookupFunction signature allows options to be the callback when
  // called from some code paths; normalize that.
  const opts = typeof options === "function" ? {} : options;
  const cb = typeof options === "function" ? options : callback;

  dnsLookup(hostname, opts as any, (err: any, addressOrList: any, family?: any) => {
    if (err) {
      return (cb as any)(err);
    }

    // dns.lookup may return either a single address (string) or, when
    // { all: true } was requested (undici does this), an array of
    // { address, family } records. Reject as soon as any resolved address
    // falls into a private range.
    const records: Array<{ address: string; family: number }> = Array.isArray(addressOrList)
      ? addressOrList
      : [{ address: addressOrList, family }];

    for (const rec of records) {
      if (typeof rec?.address === "string" && isPrivateAddress(rec.address)) {
        const blocked: NodeJS.ErrnoException = new Error(
          `Blocked attempt to connect to private address ${rec.address} for hostname "${hostname}"`
        );
        blocked.code = "ERR_SSRF_BLOCKED_ADDRESS";
        return (cb as any)(blocked);
      }
    }

    (cb as any)(err, addressOrList, family);
  });
};

let _hardenedAgentInitialized = false;
let _hardenedAgent: Agent | undefined;

/**
 * Returns an undici Agent that resolves hostnames through {@link ssrfGuardedLookup}.
 * Used when MCP_HTTP_HARDEN is enabled and no explicit proxy is configured, so
 * that direct outbound connections from `web_url_read` cannot be redirected to
 * private/loopback addresses via DNS rebinding.
 */
function createHardenedAgent(): Agent {
  if (!_hardenedAgentInitialized) {
    _hardenedAgentInitialized = true;
    _hardenedAgent = new Agent({
      connect: {
        ...getConnectOptions(),
        lookup: ssrfGuardedLookup,
      },
    });
  }
  return _hardenedAgent!;
}

function applyCharacterPagination(content: string, startChar: number = 0, maxLength?: number): string {
  if (startChar >= content.length) {
    return "";
  }

  const start = Math.max(0, startChar);
  const end = maxLength ? Math.min(content.length, start + maxLength) : content.length;

  return content.slice(start, end);
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractSection(markdownContent: string, sectionHeading: string): string {
  const lines = markdownContent.split('\n');
  const sectionRegex = new RegExp(`^#{1,6}\\s*.*${escapeRegExp(sectionHeading)}.*$`, 'i');

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
  if (options.startChar !== undefined || options.maxLength !== undefined) {
    result = applyCharacterPagination(result, options.startChar, options.maxLength);
  }

  return result;
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

  // Create an AbortController instance
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // Prepare request options with proxy support
    const requestOptions: RequestInit = {
      signal: controller.signal,
    };

    // Add proxy or default dispatcher (includes system CA certs for TLS)
    const proxyAgent = createProxyAgent(url, ProxyType.URL_READER);
    // When hardened (and not explicitly allowing private URLs), bind a custom
    // socket lookup that rejects private/loopback IPs at connect time. This
    // closes the DNS-rebinding TOCTOU between assertUrlAllowed() above and
    // the actual fetch(). When a proxy is configured the proxy performs DNS
    // resolution, so the rebinding vector doesn't apply at the client.
    const security = getHttpSecurityConfig();
    const useDnsRebindingGuard = security.harden && !security.allowPrivateUrls && !proxyAgent;
    const dispatcher = proxyAgent
      ?? (useDnsRebindingGuard ? createHardenedAgent() : createDefaultAgent());
    if (dispatcher) {
      (requestOptions as any).dispatcher = dispatcher;
    }

    // Add User-Agent header if configured (URL_READER_USER_AGENT takes priority over USER_AGENT)
    const userAgent = process.env.URL_READER_USER_AGENT || process.env.USER_AGENT;
    if (userAgent) {
      requestOptions.headers = {
        ...requestOptions.headers,
        'User-Agent': userAgent
      };
    }

    let response: Response;
    try {
      // Fetch the URL with the abort signal.
      // Use undici's own fetch so it shares the same internal version as the
      // Agent/ProxyAgent dispatcher — avoids the Node.js bundled-undici vs
      // npm-undici version mismatch that breaks Content-Encoding decompression.
      response = await (undiciFetch as unknown as typeof fetch)(url, requestOptions);
    } catch (error: any) {
      // Surface DNS-rebinding blocks as a security policy error rather than
      // a generic network failure, so callers/tests can distinguish them.
      const cause = error?.cause;
      if (error?.code === "ERR_SSRF_BLOCKED_ADDRESS"
          || cause?.code === "ERR_SSRF_BLOCKED_ADDRESS") {
        throw createURLSecurityPolicyError(url);
      }
      const context: ErrorContext = {
        url,
        proxyAgent: !!dispatcher,
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
