import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetch as undiciFetch } from "undici";
import { createConfigurationError, createContentError } from "./error-handler.js";
import { parseStrictInteger } from "./env-int.js";
import { logMessage } from "./logging.js";
import { applyTrustedServiceRequestConfig } from "./proxy.js";

const DEFAULT_FLARESOLVERR_TIMEOUT_MS = 60_000;
const MAX_FLARESOLVERR_TIMEOUT_MS = 300_000;
const DEFAULT_FLARESOLVERR_CONCURRENCY = 2;
const MAX_FLARESOLVERR_CONCURRENCY = 16;
const MAX_FLARESOLVERR_RESPONSE_BYTES = 256 * 1024;
const FLARESOLVERR_RESPONSE_GRACE_MS = 5_000;
const MAX_COOKIE_PAIR_BYTES = 4_096;

export interface FlareSolverrConfig {
  endpoint: URL;
  timeoutMs: number;
  maxConcurrentRequests: number;
}

export interface FlareSolverrCookie {
  name?: unknown;
  value?: unknown;
  domain?: unknown;
  path?: unknown;
  secure?: unknown;
  expires?: unknown;
}

export interface FlareSolverrSolution {
  url: string;
  status: number;
  cookies: FlareSolverrCookie[];
  userAgent: string;
}

export type FlareSolverrAcquisition =
  | { kind: "solved"; solution: FlareSolverrSolution }
  | { kind: "fallback"; reason: "busy" | "unavailable" };

let activeSolverRequests = 0;

function resolveBoundedInteger(
  mcpServer: McpServer,
  name: "FLARESOLVERR_TIMEOUT_MS" | "FLARESOLVERR_MAX_CONCURRENT_REQUESTS",
  fallback: number,
  maximum: number,
): number {
  const rawValue = process.env[name];
  if (rawValue === undefined || rawValue.trim() === "") {
    return fallback;
  }

  const parsed = parseStrictInteger(rawValue);
  if (parsed === undefined || parsed <= 0 || parsed > maximum) {
    logMessage(
      mcpServer,
      "warning",
      `Ignoring invalid ${name}. Expected an integer from 1 through ${maximum}; using default ${fallback}.`,
    );
    return fallback;
  }

  return parsed;
}

function normalizeSolverEndpoint(rawValue: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(rawValue.trim());
  } catch {
    throw createConfigurationError(
      "FLARESOLVERR_URL must be an absolute HTTP or HTTPS service base URL.",
    );
  }

  if (
    !["http:", "https:"].includes(endpoint.protocol)
    || endpoint.search !== ""
    || endpoint.hash !== ""
  ) {
    throw createConfigurationError(
      "FLARESOLVERR_URL must be an absolute HTTP or HTTPS service base URL without a query or fragment.",
    );
  }

  const pathWithoutTrailingSlash = endpoint.pathname.replace(/\/+$/u, "");
  endpoint.pathname = pathWithoutTrailingSlash.endsWith("/v1")
    ? pathWithoutTrailingSlash
    : `${pathWithoutTrailingSlash}/v1`;
  return endpoint;
}

export function resolveFlareSolverrConfig(
  mcpServer: McpServer,
): FlareSolverrConfig | null {
  const rawUrl = process.env.FLARESOLVERR_URL;
  if (rawUrl === undefined || rawUrl.trim() === "") {
    return null;
  }

  return {
    endpoint: normalizeSolverEndpoint(rawUrl),
    timeoutMs: resolveBoundedInteger(
      mcpServer,
      "FLARESOLVERR_TIMEOUT_MS",
      DEFAULT_FLARESOLVERR_TIMEOUT_MS,
      MAX_FLARESOLVERR_TIMEOUT_MS,
    ),
    maxConcurrentRequests: resolveBoundedInteger(
      mcpServer,
      "FLARESOLVERR_MAX_CONCURRENT_REQUESTS",
      DEFAULT_FLARESOLVERR_CONCURRENCY,
      MAX_FLARESOLVERR_CONCURRENCY,
    ),
  };
}

async function readBoundedResponse(response: Response): Promise<string | null> {
  if (response.body === null) {
    return "";
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytesRead = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }
      bytesRead += value.byteLength;
      if (bytesRead > MAX_FLARESOLVERR_RESPONSE_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(bytesRead);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8").decode(bytes);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function parseSolution(value: unknown): FlareSolverrSolution | null {
  const envelope = asRecord(value);
  if (!envelope) {
    return null;
  }
  if (envelope.status !== "ok") {
    return null;
  }
  const solution = asRecord(envelope.solution);
  if (!solution) {
    return null;
  }
  if (typeof solution.url !== "string") {
    return null;
  }
  if (!isInteger(solution.status)) {
    return null;
  }
  if (!Array.isArray(solution.cookies)) {
    return null;
  }
  if (!isNonEmptyString(solution.userAgent)) {
    return null;
  }

  return {
    url: solution.url,
    status: solution.status,
    cookies: solution.cookies as FlareSolverrCookie[],
    userAgent: solution.userAgent,
  };
}

function validateSolutionUrl(solution: FlareSolverrSolution, requestedUrl: URL): void {
  let solvedUrl: URL;
  try {
    solvedUrl = new URL(solution.url);
  } catch {
    throw createContentError("FlareSolverr returned an invalid solution URL.", requestedUrl.href);
  }
  if (
    !["http:", "https:"].includes(solvedUrl.protocol)
    || solvedUrl.hostname.toLowerCase() !== requestedUrl.hostname.toLowerCase()
  ) {
    throw createContentError(
      "FlareSolverr returned a solution URL on a different or unsupported hostname.",
      requestedUrl.href,
    );
  }
}

function logDirectFallback(mcpServer: McpServer): void {
  logMessage(
    mcpServer,
    "warning",
    "FlareSolverr session acquisition failed; using the direct URL fetch path.",
  );
}

async function requestFlareSolverrSession(
  config: FlareSolverrConfig,
  requestedUrl: URL,
): Promise<string | null> {
  const timeoutSignal = AbortSignal.timeout(
    config.timeoutMs + FLARESOLVERR_RESPONSE_GRACE_MS,
  );

  try {
    const requestOptions: RequestInit = {
      method: "POST",
      signal: timeoutSignal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cmd: "request.get",
        url: requestedUrl.href,
        maxTimeout: config.timeoutMs,
        returnOnlyCookies: true,
      }),
    };
    applyTrustedServiceRequestConfig(requestOptions, config.endpoint.href);
    const response = await (undiciFetch as unknown as typeof fetch)(
      config.endpoint,
      requestOptions,
    );
    const isPersistentClientError = response.status >= 400
      && response.status < 500
      && response.status !== 408
      && response.status !== 429;
    if (isPersistentClientError) {
      await response.body?.cancel();
      throw createConfigurationError(
        "FlareSolverr endpoint rejected the request. Check FLARESOLVERR_URL and service API compatibility.",
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    return await readBoundedResponse(response);
  } catch (error: any) {
    if (error?.name === "MCPSearXNGError") {
      throw error;
    }
    return null;
  }
}

function decodeSolution(responseText: string | null): FlareSolverrSolution | null {
  if (responseText === null) {
    return null;
  }
  try {
    return parseSolution(JSON.parse(responseText));
  } catch {
    return null;
  }
}

export async function acquireFlareSolverrSolution(
  mcpServer: McpServer,
  config: FlareSolverrConfig,
  requestedUrl: URL,
): Promise<FlareSolverrAcquisition> {
  if (activeSolverRequests >= config.maxConcurrentRequests) {
    logMessage(
      mcpServer,
      "warning",
      "FlareSolverr concurrency limit reached; using the direct URL fetch path.",
    );
    return { kind: "fallback", reason: "busy" };
  }

  activeSolverRequests++;
  try {
    const solution = decodeSolution(
      await requestFlareSolverrSession(config, requestedUrl),
    );
    if (!solution) {
      logDirectFallback(mcpServer);
      return { kind: "fallback", reason: "unavailable" };
    }
    validateSolutionUrl(solution, requestedUrl);
    return { kind: "solved", solution };
  } finally {
    activeSolverRequests--;
  }
}

function cookiePath(cookie: FlareSolverrCookie): string {
  return typeof cookie.path === "string" && cookie.path.startsWith("/")
    ? cookie.path
    : "/";
}

function pathMatches(requestPath: string, candidate: string): boolean {
  if (requestPath === candidate) {
    return true;
  }
  if (!requestPath.startsWith(candidate)) {
    return false;
  }
  return candidate.endsWith("/") || requestPath[candidate.length] === "/";
}

function domainMatches(
  cookie: FlareSolverrCookie,
  requestHostname: string,
  solutionHostname: string,
): boolean {
  if (typeof cookie.domain !== "string" || cookie.domain.trim() === "") {
    return requestHostname === solutionHostname;
  }
  const domain = cookie.domain.trim().toLowerCase().replace(/^\./u, "");
  return requestHostname === domain || requestHostname.endsWith(`.${domain}`);
}

function isValidCookieName(name: string): boolean {
  if (name === "") {
    return false;
  }
  const punctuation = "!#$%&'*+-.^_`|~";
  for (const character of name) {
    const code = character.charCodeAt(0);
    const isAlphaNumeric = (
      (code >= 0x30 && code <= 0x39)
      || (code >= 0x41 && code <= 0x5a)
      || (code >= 0x61 && code <= 0x7a)
    );
    if (!isAlphaNumeric && !punctuation.includes(character)) {
      return false;
    }
  }
  return true;
}

function isValidCookieValue(value: string): boolean {
  return /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/u.test(value);
}

function isValidCookiePair(name: string, value: string): boolean {
  return isValidCookieName(name)
    && isValidCookieValue(value)
    && new TextEncoder().encode(`${name}=${value}`).byteLength <= MAX_COOKIE_PAIR_BYTES;
}

interface IndexedCookie {
  cookie: FlareSolverrCookie;
  index: number;
  path: string;
}

function isUnexpired(cookie: FlareSolverrCookie, nowSeconds: number): boolean {
  return typeof cookie.expires !== "number"
    || !Number.isFinite(cookie.expires)
    || cookie.expires <= 0
    || cookie.expires > nowSeconds;
}

interface NamedCookie extends FlareSolverrCookie {
  name: string;
  value: string;
}

function hasCookieIdentity(cookie: FlareSolverrCookie): cookie is NamedCookie {
  return typeof cookie.name === "string" && typeof cookie.value === "string";
}

function cookieTransportMatches(
  cookie: FlareSolverrCookie,
  path: string,
  targetUrl: URL,
  requestHostname: string,
  solutionHostname: string,
  nowSeconds: number,
): boolean {
  const secureTransportAllowed = cookie.secure !== true || targetUrl.protocol === "https:";
  return domainMatches(cookie, requestHostname, solutionHostname)
    && pathMatches(targetUrl.pathname, path)
    && secureTransportAllowed
    && isUnexpired(cookie, nowSeconds);
}

function cookieMatchesTarget(
  entry: IndexedCookie,
  targetUrl: URL,
  requestHostname: string,
  solutionHostname: string,
  nowSeconds: number,
): boolean {
  const { cookie, path } = entry;
  if (requestHostname !== solutionHostname) {
    return false;
  }
  if (!hasCookieIdentity(cookie)) {
    return false;
  }
  return isValidCookiePair(cookie.name, cookie.value)
    && cookieTransportMatches(
      cookie,
      path,
      targetUrl,
      requestHostname,
      solutionHostname,
      nowSeconds,
    );
}

export function buildFlareSolverrHeaders(
  solution: FlareSolverrSolution,
  targetUrl: URL,
  nowSeconds: number = Date.now() / 1000,
): Record<string, string> {
  const requestHostname = targetUrl.hostname.toLowerCase();
  const solutionHostname = new URL(solution.url).hostname.toLowerCase();
  const matches = solution.cookies
    .map((cookie, index) => ({ cookie, index, path: cookiePath(cookie) }))
    .filter((entry) => cookieMatchesTarget(
      entry,
      targetUrl,
      requestHostname,
      solutionHostname,
      nowSeconds,
    ))
    .sort((left, right) => right.path.length - left.path.length || left.index - right.index);

  const selected = new Set<string>();
  const pairs: string[] = [];
  for (const { cookie } of matches) {
    const name = cookie.name as string;
    if (selected.has(name)) {
      continue;
    }
    selected.add(name);
    pairs.push(`${name}=${cookie.value as string}`);
  }

  const headers: Record<string, string> = { "User-Agent": solution.userAgent };
  if (pairs.length > 0) {
    headers.Cookie = pairs.join("; ");
  }
  return headers;
}

export function createFlareSolverrCacheKey(requestedUrl: string): string {
  return `solver:${requestedUrl}`;
}
