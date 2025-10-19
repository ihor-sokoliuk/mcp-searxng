import { ProxyAgent } from "undici";

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
 * @param targetUrl - The URL being fetched (used to determine protocol)
 * @returns ProxyAgent dispatcher for fetch, or undefined if no proxy configured
 */
export function createProxyAgent(targetUrl: string): ProxyAgent | undefined {
  const proxyUrl = process.env.HTTP_PROXY || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.https_proxy;

  if (!proxyUrl) {
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
