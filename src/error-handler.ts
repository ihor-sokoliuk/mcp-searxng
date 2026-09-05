/**
 * Concise error handling for MCP SearXNG server
 * Provides clear, focused error messages that identify the root cause
 */

import { parseSearxngUrls, validateSearxngInstanceUrl } from "./searxng-instances.js";
import { validateBrowserSolverEnvironment } from "./browser-solver-config.js";
import { sanitizeErrorForTransport } from "./diagnostic-sanitizer.js";
import { writeDiagnostic } from "./diagnostic-output.js";

export interface ErrorContext {
  url?: string;
  searxngUrl?: string;
  proxyAgent?: boolean;
  timeout?: number;
  query?: string;
}

export class MCPSearXNGError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MCPSearXNGError';
  }
}

export function createConfigurationError(message: string): MCPSearXNGError {
  return new MCPSearXNGError(`🔧 Configuration Error: ${message}`);
}

const TLS_ERROR_CODES = new Set([
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'CERT_UNTRUSTED', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_GET_ISSUER_CERT',
  'CERT_CHAIN_TOO_LONG', 'INVALID_CA',
]);

function isTLSError(error: any): boolean {
  if (TLS_ERROR_CODES.has(error?.code)) return true;
  if (TLS_ERROR_CODES.has(error?.cause?.code)) return true;
  if (error?.message?.includes('certificate')) return true;
  if (error?.cause?.message?.includes('certificate')) return true;
  return false;
}

function getTLSRemediationMessage(): string {
  const { platform } = process;
  if (platform === 'win32') {
    return 'Set NODE_EXTRA_CA_CERTS=C:\\path\\to\\ca-bundle.pem before starting the server.';
  }
  if (platform === 'darwin') {
    return 'Run: sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain /path/to/ca.crt';
  }
  return 'Run: sudo cp /path/to/ca.crt /usr/local/share/ca-certificates/ && sudo update-ca-certificates';
}

export function createNetworkError(error: any, context: ErrorContext): MCPSearXNGError {
  const target = context.searxngUrl ? 'SearXNG server' : 'website';
  
  if (error.code === 'ECONNREFUSED') {
    return new MCPSearXNGError(`🌐 Connection Error: ${target} is not responding (${context.url})`);
  }
  
  if (error.code === 'ENOTFOUND' || error.code === 'EAI_NONAME') {
    const hostname = context.url ? new URL(context.url).hostname : 'unknown';
    return new MCPSearXNGError(`🌐 DNS Error: Cannot resolve hostname "${hostname}"`);
  }
  
  if (error.code === 'ETIMEDOUT') {
    return new MCPSearXNGError(`🌐 Timeout Error: ${target} is too slow to respond`);
  }
  
  if (isTLSError(error)) {
    const causeCode = error?.cause?.code || error?.code || 'CERT_ERROR';
    return new MCPSearXNGError(
      `🔒 SSL/TLS Error: Certificate verification failed for ${target} (${causeCode}). ` +
      getTLSRemediationMessage()
    );
  }
  
  // For generic fetch failures, provide root cause guidance
  const errorMsg = error.message || error.code || 'Connection failed';
  if (errorMsg === 'fetch failed' || errorMsg === 'Connection failed') {
    const guidance = context.searxngUrl 
      ? 'Check if the SEARXNG_URL is correct and the SearXNG server is available'
      : 'Check if the website URL is accessible';
    return new MCPSearXNGError(`🌐 Network Error: ${errorMsg}. ${guidance}`);
  }
  
  return new MCPSearXNGError(`🌐 Network Error: ${errorMsg}`);
}

export function createServerError(status: number, statusText: string, responseBody: string, context: ErrorContext): MCPSearXNGError {
  const target = context.searxngUrl ? 'SearXNG server' : 'Website';
  
  if (status === 403) {
    const reason = context.searxngUrl ? 'Authentication required or IP blocked' : 'Access blocked (bot detection or geo-restriction)';
    return new MCPSearXNGError(`🚫 ${target} Error (${status}): ${reason}`);
  }
  
  if (status === 404) {
    const reason = context.searxngUrl ? 'Search endpoint not found' : 'Page not found';
    return new MCPSearXNGError(`🚫 ${target} Error (${status}): ${reason}`);
  }
  
  if (status === 429) {
    return new MCPSearXNGError(`🚫 ${target} Error (${status}): Rate limit exceeded`);
  }
  
  if (status >= 500) {
    return new MCPSearXNGError(`🚫 ${target} Error (${status}): Internal server error`);
  }
  
  return new MCPSearXNGError(`🚫 ${target} Error (${status}): ${statusText}`);
}

export function createJSONError(responseText: string): MCPSearXNGError {
  const preview = responseText.substring(0, 100).replace(/\n/g, ' ');
  return new MCPSearXNGError(`🔍 SearXNG Response Error: Invalid JSON format. Response: "${preview}...". Enable - json under search.formats in your SearXNG settings.yml, or set SEARXNG_HTML_FALLBACK=true.`);
}

export function createDataError(): MCPSearXNGError {
  return new MCPSearXNGError(`🔍 SearXNG Data Error: Missing results array in response`);
}

export function createNoResultsMessage(query: string): string {
  return `🔍 No results found for "${query}". Try different search terms or check if SearXNG search engines are working.`;
}

const MAX_ENGINE_FAILURE_TEXT_CHARS = 120;

function asEngineFailureText(value: unknown): string {
  if (typeof value !== "string") return '';
  return value.replace(/[\r\n\u2028\u2029]+/gu, ' ').trim().slice(0, MAX_ENGINE_FAILURE_TEXT_CHARS);
}

const UNKNOWN_ENGINE_LABEL = 'unknown engine';

/**
 * Coerce one `unresponsive_engines` entry into a usable `[engine, reason]` pair.
 *
 * SearXNG responses are cast to `SearXNGWeb`, never runtime-validated, so an
 * entry can be `null`, a bare string, a short tuple, or anything else. Both the
 * zero-row classifier in search.ts and the renderer below normalize through
 * here, so "malformed" means one thing in this code path and the engine name is
 * always a string — safe to use as a map key and safe to interpolate.
 */
export function normalizeEngineFailure(entry: unknown): [string, string] {
  const [rawEngine, rawReason] = Array.isArray(entry) ? entry : [entry, undefined];
  return [asEngineFailureText(rawEngine) || UNKNOWN_ENGINE_LABEL, asEngineFailureText(rawReason)];
}

function describeEngineFailure(entry: unknown): string {
  const [engine, reason] = normalizeEngineFailure(entry);
  return reason ? `${engine} (${reason})` : engine;
}

/**
 * Raised when SearXNG returns zero results and reports failing engines.
 *
 * Without this the caller receives createNoResultsMessage(), which is
 * indistinguishable from a search that ran cleanly and matched nothing.
 */
export function createEngineFailureError(query: string, unresponsiveEngines: Array<[string, string]>): MCPSearXNGError {
  const failures = unresponsiveEngines.map(describeEngineFailure).join(', ');
  return new MCPSearXNGError(
    `🔍 SearXNG Engine Error: "${query}" returned 0 results and these engines failed: ${failures}. ` +
    `An empty result set alongside failing engines does not mean nothing matched — the search may not have run. ` +
    `Retry, select different engines, or check the SearXNG instance.`
  );
}

export function createURLFormatError(url: string): MCPSearXNGError {
  return new MCPSearXNGError(`🔧 URL Format Error: Invalid URL "${url}"`);
}

export function createURLSecurityPolicyError(url: string): MCPSearXNGError {
  return new MCPSearXNGError(
    `🔒 URL blocked by security policy: ${url}. ` +
    "Enable MCP_HTTP_ALLOW_PRIVATE_URLS=true only if internal URL reads are intentional."
  );
}

export function createContentError(message: string, url: string): MCPSearXNGError {
  return new MCPSearXNGError(`📄 Content Error: ${message} (${url})`);
}

export function createConversionError(url: string): MCPSearXNGError {
  return new MCPSearXNGError(`🔄 Conversion Error: Cannot convert HTML to Markdown (${url})`);
}

export function createTimeoutError(timeout: number, url: string): MCPSearXNGError {
  const hostname = new URL(url).hostname;
  return new MCPSearXNGError(`⏱️ Timeout Error: ${hostname} took longer than ${timeout}ms to respond`);
}

export function createEmptyContentWarning(url: string): string {
  return `📄 Content Warning: Page fetched but appears empty after conversion (${url}). May contain only media or require JavaScript.`;
}

export function createUnexpectedError(error: any, context: ErrorContext): MCPSearXNGError {
  return new MCPSearXNGError(`❓ Unexpected Error: ${error.message || String(error)}`);
}

/**
 * Process-level crash handlers, registered by the CLI entrypoint (cli.ts).
 *
 * Extracted here so the logic is unit-testable: cli.ts calls main() at import
 * time (it must always start the server — see issue #91), so it cannot be
 * imported to test these in place.
 */
export function handleUncaughtException(error: unknown): void {
  writeDiagnostic('error', 'Uncaught Exception:', sanitizeErrorForTransport(error));
  process.exit(1);
}

export function handleUnhandledRejection(reason: unknown, promise: Promise<unknown>): void {
  void promise;
  writeDiagnostic('error', 'Unhandled Rejection:', sanitizeErrorForTransport(reason));
  process.exit(1);
}

export function validateEnvironment(): string | null {
  const issues: string[] = [];
  
  const searxngUrls = parseSearxngUrls();
  if (searxngUrls.length === 0) {
    issues.push("SEARXNG_URL not set");
  } else {
    for (const [index, searxngUrl] of searxngUrls.entries()) {
      const validationError = validateSearxngInstanceUrl(searxngUrl, index + 1);
      if (validationError) {
        issues.push(validationError);
      }
    }
  }

  const authUsername = process.env.AUTH_USERNAME;
  const authPassword = process.env.AUTH_PASSWORD;
  
  if (authUsername && !authPassword) {
    issues.push("AUTH_USERNAME set but AUTH_PASSWORD missing");
  } else if (!authUsername && authPassword) {
    issues.push("AUTH_PASSWORD set but AUTH_USERNAME missing");
  }

  const browserSolverIssue = validateBrowserSolverEnvironment();
  if (browserSolverIssue) {
    issues.push(browserSolverIssue);
  }

  if (issues.length === 0) {
    return null;
  }

  return `⚠️ Configuration Issues: ${issues.join(', ')}. Set SEARXNG_URL (e.g., http://localhost:8080 or https://search.example.com)`;
}
