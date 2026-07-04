import * as dns from "node:dns";
import { Agent, ProxyAgent } from "undici";
import { getHttpSecurityConfig } from "./http-security.js";
import { getConnectOptions } from "./tls-config.js";
import { createUrlSecurityPolicyDnsError, isPrivateAddress } from "./url-security.js";

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | dns.LookupAddress[],
  family?: number,
) => void;

export function createUrlReaderLookup() {
  return (hostname: string, options: dns.LookupOptions, callback: LookupCallback): void => {
    if (getHttpSecurityConfig().allowPrivateUrls) {
      (dns.lookup as any)(hostname, options, callback);
      return;
    }

    dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) {
        callback(error, options.all ? [] : "");
        return;
      }

      if (addresses.length === 0) {
        const notFound = new Error(`No DNS records found for ${hostname}`) as NodeJS.ErrnoException;
        notFound.code = "ENOTFOUND";
        callback(notFound, options.all ? [] : "");
        return;
      }

      if (addresses.some(({ address }) => isPrivateAddress(address))) {
        callback(createUrlSecurityPolicyDnsError(hostname), options.all ? [] : "");
        return;
      }

      const selected = addresses[0];
      if (options.all) {
        callback(null, [selected]);
        return;
      }

      callback(null, selected.address, selected.family);
    });
  };
}

/**
 * Checks if a target URL should bypass the proxy based on NO_PROXY environment variable.
 * 
 * @param targetUrl - The URL to check against NO_PROXY rules
 * @returns true if the URL should bypass the proxy, false otherwise
 */
function shouldBypassProxy(targetUrl: string): boolean {
  const noProxy = process.env.NO_PROXY || process.env.no_proxy;
  
  if (!noProxy) {
    return false;
  }

  // Wildcard bypass
  if (noProxy.trim() === '*') {
    return true;
  }

  let hostname: string;
  try {
    const url = new URL(targetUrl);
    hostname = url.hostname.toLowerCase();
  } catch (error) {
    // Invalid URL, don't bypass
    return false;
  }

  // Parse comma-separated list of bypass patterns
  const bypassPatterns = noProxy.split(',').map(pattern => pattern.trim().toLowerCase());

  for (const pattern of bypassPatterns) {
    if (!pattern) continue;

    // Exact hostname match
    if (hostname === pattern) {
      return true;
    }

    // Domain suffix match with leading dot (e.g., .example.com matches sub.example.com)
    if (pattern.startsWith('.') && hostname.endsWith(pattern)) {
      return true;
    }

    // Domain suffix match without leading dot (e.g., example.com matches sub.example.com and example.com)
    if (!pattern.startsWith('.')) {
      // Exact match
      if (hostname === pattern) {
        return true;
      }
      // Subdomain match
      if (hostname.endsWith(`.${pattern}`)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Proxy configuration type for separating search and URL reader proxies.
 */
export const ProxyType = {
  SEARCH: 'search',
  URL_READER: 'url_reader',
} as const;

export type ProxyType = typeof ProxyType[keyof typeof ProxyType];

/**
 * Gets proxy URL for the specified proxy type.
 * Checks type-specific proxy first, then falls back to global proxy.
 *
 * @param type - The type of proxy to get ('search' or 'url_reader')
 * @param targetUrl - Optional target URL whose protocol is used to select between HTTP and HTTPS proxies
 * @returns The proxy URL or undefined if not configured
 */
function getProxyUrl(type?: ProxyType, targetUrl?: string): string | undefined {
  let isHttps = false;
  if (targetUrl) {
    try {
      const url = new URL(targetUrl);
      isHttps = url.protocol === 'https:';
    } catch {
      isHttps = false;
    }
  }

  if (type === ProxyType.SEARCH) {
    if (isHttps) {
      return process.env.SEARCH_HTTPS_PROXY ||
             process.env.SEARCH_HTTP_PROXY ||
             process.env.search_https_proxy ||
             process.env.search_http_proxy ||
             process.env.HTTPS_PROXY ||
             process.env.HTTP_PROXY ||
             process.env.https_proxy ||
             process.env.http_proxy;
    }
    return process.env.SEARCH_HTTP_PROXY ||
           process.env.SEARCH_HTTPS_PROXY ||
           process.env.search_http_proxy ||
           process.env.search_https_proxy ||
           // Fallback to global proxies
           process.env.HTTP_PROXY ||
           process.env.HTTPS_PROXY ||
           process.env.http_proxy ||
           process.env.https_proxy;
  }

  if (type === ProxyType.URL_READER) {
    if (isHttps) {
      return process.env.URL_READER_HTTPS_PROXY ||
             process.env.URL_READER_HTTP_PROXY ||
             process.env.url_reader_https_proxy ||
             process.env.url_reader_http_proxy ||
             process.env.HTTPS_PROXY ||
             process.env.HTTP_PROXY ||
             process.env.https_proxy ||
             process.env.http_proxy;
    }
    return process.env.URL_READER_HTTP_PROXY ||
           process.env.URL_READER_HTTPS_PROXY ||
           process.env.url_reader_http_proxy ||
           process.env.url_reader_https_proxy ||
           // Fallback to global proxies
           process.env.HTTP_PROXY ||
           process.env.HTTPS_PROXY ||
           process.env.http_proxy ||
           process.env.https_proxy;
  }

  if (isHttps) {
    return process.env.HTTPS_PROXY ||
           process.env.HTTP_PROXY ||
           process.env.https_proxy ||
           process.env.http_proxy;
  }
  return process.env.HTTP_PROXY ||
         process.env.HTTPS_PROXY ||
         process.env.http_proxy ||
         process.env.https_proxy;
}

/**
 * Creates a proxy agent dispatcher for Node.js fetch API.
 *
 * Node.js fetch uses Undici under the hood, which requires a 'dispatcher' option
 * instead of 'agent'. This function creates a ProxyAgent compatible with fetch.
 *
 * Environment variables checked (in order, depending on URL protocol):
 * - For type 'search' and HTTPS URLs:
 *   SEARCH_HTTPS_PROXY, SEARCH_HTTP_PROXY, search_https_proxy, search_http_proxy,
 *   then HTTPS_PROXY, HTTP_PROXY, https_proxy, http_proxy
 * - For type 'search' and HTTP/unknown URLs:
 *   SEARCH_HTTP_PROXY, SEARCH_HTTPS_PROXY, search_http_proxy, search_https_proxy,
 *   then HTTP_PROXY, HTTPS_PROXY, http_proxy, https_proxy
 * - For type 'url_reader' and HTTPS URLs:
 *   URL_READER_HTTPS_PROXY, URL_READER_HTTP_PROXY, url_reader_https_proxy, url_reader_http_proxy,
 *   then HTTPS_PROXY, HTTP_PROXY, https_proxy, http_proxy
 * - For type 'url_reader' and HTTP/unknown URLs:
 *   URL_READER_HTTP_PROXY, URL_READER_HTTPS_PROXY, url_reader_http_proxy, url_reader_https_proxy,
 *   then HTTP_PROXY, HTTPS_PROXY, http_proxy, https_proxy
 * - For no specific type and HTTPS URLs:
 *   HTTPS_PROXY, HTTP_PROXY, https_proxy, http_proxy
 * - For no specific type and HTTP/unknown URLs:
 *   HTTP_PROXY, HTTPS_PROXY, http_proxy, https_proxy
 * - NO_PROXY / no_proxy: Comma-separated list of hosts to bypass proxy
 *
 * @param targetUrl - Optional target URL to check against NO_PROXY rules
 * @param type - Optional proxy type ('search' or 'url_reader') for separate proxy configs
 * @returns ProxyAgent dispatcher for fetch, or undefined if no proxy configured or bypassed
 */
export function createProxyAgent(targetUrl?: string, type?: ProxyType): ProxyAgent | undefined {
  const proxyUrl = getProxyUrl(type, targetUrl);

  if (!proxyUrl) {
    return undefined;
  }

  // Check if target URL should bypass proxy
  if (targetUrl && shouldBypassProxy(targetUrl)) {
    return undefined;
  }

  // Validate and normalize proxy URL
  let parsedProxyUrl: URL;
  try {
    parsedProxyUrl = new URL(proxyUrl);
  } catch (error) {
    throw new Error(
      `Invalid proxy URL: ${proxyUrl}. ` +
      "Please provide a valid URL (e.g., http://proxy:8080 or http://user:pass@proxy:8080)"
    );
  }

  // Ensure proxy protocol is supported
  if (!['http:', 'https:'].includes(parsedProxyUrl.protocol)) {
    throw new Error(
      `Unsupported proxy protocol: ${parsedProxyUrl.protocol}. ` +
      "Only HTTP and HTTPS proxies are supported."
    );
  }

  // Reconstruct base proxy URL preserving credentials
  const auth = parsedProxyUrl.username ? 
    (parsedProxyUrl.password ? `${parsedProxyUrl.username}:${parsedProxyUrl.password}@` : `${parsedProxyUrl.username}@`) : 
    '';
  const normalizedProxyUrl = `${parsedProxyUrl.protocol}//${auth}${parsedProxyUrl.host}`;

  // Create and return Undici ProxyAgent compatible with fetch's dispatcher option
  return new ProxyAgent({ uri: normalizedProxyUrl, connect: getConnectOptions() });
}

/**
 * Returns a singleton undici Agent with system CA certificates in the connect
 * options. Used as a dispatcher when no proxy is configured, to ensure
 * undici's fetch uses system CAs instead of only Node's compiled-in bundle.
 *
 * The agent (and the CA bundle disk read) is created once and reused across
 * requests to avoid repeated synchronous I/O and connection pool proliferation.
 *
 * Returns undefined if no system CA bundle is found — callers should treat
 * undefined as "use Node's default behavior".
 */
let _defaultAgentInitialized = false;
let _defaultAgent: Agent | undefined;
let _urlReaderAgent: Agent | undefined;

export function createDefaultAgent(): Agent | undefined {
  if (!_defaultAgentInitialized) {
    _defaultAgentInitialized = true;
    const connectOpts = getConnectOptions();
    if (Object.keys(connectOpts).length > 0) {
      _defaultAgent = new Agent({ connect: connectOpts });
    }
  }
  return _defaultAgent;
}

/**
 * Apply the shared SearXNG-instance request configuration — the SEARCH-group
 * proxy dispatcher and the global `USER_AGENT` header — to an outgoing request.
 *
 * Used by the two instance-side fetches that don't build their own auth headers:
 * the `/config` fetch (`instance-info.ts`) and the autocompleter fetch
 * (`suggestions.ts`), so both route through the same proxy and present a
 * consistent User-Agent identity without duplicating the wiring. `searxng_web_search`
 * still builds its own options in `search.ts` (Basic-Auth handling is interleaved
 * there); folding it in here is tracked under FEAT-050.
 *
 * The User-Agent is merged through a `Headers` instance, so any already-set
 * `headers` — whether a plain object, a `Headers` instance, or a tuple array —
 * is preserved; the result is written back as a plain object. (In practice both
 * callers pass a freshly-built `RequestInit` with no prior headers.)
 */
export function applySearchRequestConfig(
  requestOptions: RequestInit,
  targetUrl: string,
): void {
  const proxyAgent = createProxyAgent(targetUrl, ProxyType.SEARCH);
  const dispatcher = proxyAgent ?? createDefaultAgent();
  if (dispatcher) {
    (requestOptions as any).dispatcher = dispatcher;
  }

  const userAgent = process.env.USER_AGENT;
  if (userAgent) {
    // Normalize via Headers so any HeadersInit shape (plain object, Headers
    // instance, or tuple array) merges without dropping already-set entries,
    // then hand back a plain object.
    const headers = new Headers(requestOptions.headers);
    headers.set("User-Agent", userAgent);
    requestOptions.headers = Object.fromEntries(headers);
  }
}

/**
 * Returns a singleton undici Agent for direct `web_url_read` requests.
 *
 * Unlike the shared default agent, this is always created so the URL reader's
 * DNS validation hook is present even when no system CA bundle is detected.
 */
export function createUrlReaderAgent(): Agent {
  if (!_urlReaderAgent) {
    _urlReaderAgent = new Agent({
      connect: {
        ...getConnectOptions(),
        lookup: createUrlReaderLookup(),
      },
    });
  }

  return _urlReaderAgent;
}
