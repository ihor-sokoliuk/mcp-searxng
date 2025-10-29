import { ProxyAgent } from "undici";

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
 * Creates a proxy agent dispatcher for Node.js fetch API.
 * 
 * Node.js fetch uses Undici under the hood, which requires a 'dispatcher' option
 * instead of 'agent'. This function creates a ProxyAgent compatible with fetch.
 * 
 * Environment variables checked (in order):
 * - HTTP_PROXY / http_proxy: For HTTP requests
 * - HTTPS_PROXY / https_proxy: For HTTPS requests
 * - NO_PROXY / no_proxy: Comma-separated list of hosts to bypass proxy
 * 
 * @param targetUrl - Optional target URL to check against NO_PROXY rules
 * @returns ProxyAgent dispatcher for fetch, or undefined if no proxy configured or bypassed
 */
export function createProxyAgent(targetUrl?: string): ProxyAgent | undefined {
  const proxyUrl = process.env.HTTP_PROXY || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.https_proxy;

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
  return new ProxyAgent(normalizedProxyUrl);
}
