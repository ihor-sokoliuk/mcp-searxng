import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetch as undiciFetch } from "undici";
import { createConfigurationError, createContentError } from "./error-handler.js";
import {
  BrowserSolverConfigurationIssue,
  resolveBrowserSolverEndpoint,
  type BrowserSolverProvider,
} from "./browser-solver-config.js";
import { parseStrictInteger } from "./env-int.js";
import { logMessage } from "./logging.js";
import { applyTrustedServiceRequestConfig } from "./proxy.js";

export const DEFAULT_FLARESOLVERR_TIMEOUT_MS = 60_000;
export const MAX_FLARESOLVERR_TIMEOUT_MS = 300_000;
export const DEFAULT_FLARESOLVERR_CONCURRENCY = 2;
export const MAX_FLARESOLVERR_CONCURRENCY = 16;
export const DEFAULT_BYPARR_TIMEOUT_SECONDS = 60;
export const MAX_BYPARR_TIMEOUT_SECONDS = 300;
export const DEFAULT_BYPARR_CONCURRENCY = 2;
export const MAX_BYPARR_CONCURRENCY = 16;
export const MAX_FLARESOLVERR_RESPONSE_BYTES = 256 * 1024;
export const MAX_BYPARR_RESPONSE_BYTES = 5 * 1024 * 1024;
const BROWSER_SOLVER_RESPONSE_GRACE_MS = 5_000;
const MAX_COOKIE_PAIR_BYTES = 4_096;

export interface BrowserSolverConfig {
  provider: BrowserSolverProvider;
  endpoint: URL;
  timeoutMs: number;
  wireTimeout: number;
  maxConcurrentRequests: number;
  maxResponseBytes: number;
}

export interface BrowserSolverCookie {
  name?: unknown;
  value?: unknown;
  domain?: unknown;
  path?: unknown;
  secure?: unknown;
  expires?: unknown;
}

export interface BrowserSolverSolution {
  url: string;
  status: number;
  cookies: BrowserSolverCookie[];
  userAgent: string;
}

export type BrowserSolverAcquisition =
  | { kind: "solved"; solution: BrowserSolverSolution }
  | { kind: "fallback"; reason: "busy" | "unavailable" };

const activeSolverRequests: Record<BrowserSolverProvider, number> = {
  flaresolverr: 0,
  byparr: 0,
};

function resolveBoundedInteger(
  mcpServer: McpServer,
  name:
    | "FLARESOLVERR_TIMEOUT_MS"
    | "FLARESOLVERR_MAX_CONCURRENT_REQUESTS"
    | "BYPARR_TIMEOUT_SECONDS"
    | "BYPARR_MAX_CONCURRENT_REQUESTS",
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

function readEndpointSelection() {
  try {
    return resolveBrowserSolverEndpoint();
  } catch (error) {
    if (error instanceof BrowserSolverConfigurationIssue) {
      throw createConfigurationError(error.message);
    }
    throw error;
  }
}

function resolveByparrConfig(
  mcpServer: McpServer,
  endpoint: URL,
): BrowserSolverConfig {
  const timeoutSeconds = resolveBoundedInteger(
    mcpServer,
    "BYPARR_TIMEOUT_SECONDS",
    DEFAULT_BYPARR_TIMEOUT_SECONDS,
    MAX_BYPARR_TIMEOUT_SECONDS,
  );
  return {
    provider: "byparr",
    endpoint,
    timeoutMs: timeoutSeconds * 1000,
    wireTimeout: timeoutSeconds,
    maxConcurrentRequests: resolveBoundedInteger(
      mcpServer,
      "BYPARR_MAX_CONCURRENT_REQUESTS",
      DEFAULT_BYPARR_CONCURRENCY,
      MAX_BYPARR_CONCURRENCY,
    ),
    maxResponseBytes: MAX_BYPARR_RESPONSE_BYTES,
  };
}

function resolveFlareSolverrConfig(
  mcpServer: McpServer,
  endpoint: URL,
): BrowserSolverConfig {
  const timeoutMs = resolveBoundedInteger(
    mcpServer,
    "FLARESOLVERR_TIMEOUT_MS",
    DEFAULT_FLARESOLVERR_TIMEOUT_MS,
    MAX_FLARESOLVERR_TIMEOUT_MS,
  );
  return {
    provider: "flaresolverr",
    endpoint,
    timeoutMs,
    wireTimeout: timeoutMs,
    maxConcurrentRequests: resolveBoundedInteger(
      mcpServer,
      "FLARESOLVERR_MAX_CONCURRENT_REQUESTS",
      DEFAULT_FLARESOLVERR_CONCURRENCY,
      MAX_FLARESOLVERR_CONCURRENCY,
    ),
    maxResponseBytes: MAX_FLARESOLVERR_RESPONSE_BYTES,
  };
}

export function resolveBrowserSolverConfig(
  mcpServer: McpServer,
): BrowserSolverConfig | null {
  const selection = readEndpointSelection();
  if (!selection) {
    return null;
  }
  return selection.provider === "byparr"
    ? resolveByparrConfig(mcpServer, selection.endpoint)
    : resolveFlareSolverrConfig(mcpServer, selection.endpoint);
}

async function readBoundedResponse(
  response: Response,
  maximumBytes: number,
): Promise<string | null> {
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
      if (bytesRead > maximumBytes) {
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

function parseSolution(value: unknown): BrowserSolverSolution | null {
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
    cookies: solution.cookies as BrowserSolverCookie[],
    userAgent: solution.userAgent,
  };
}

function validateSolutionUrl(solution: BrowserSolverSolution, requestedUrl: URL): void {
  let solvedUrl: URL;
  try {
    solvedUrl = new URL(solution.url);
  } catch {
    throw createContentError("Browser solver returned an invalid solution URL.", requestedUrl.href);
  }
  if (
    !["http:", "https:"].includes(solvedUrl.protocol)
    || solvedUrl.hostname.toLowerCase() !== requestedUrl.hostname.toLowerCase()
  ) {
    throw createContentError(
      "Browser solver returned a solution URL on a different or unsupported hostname.",
      requestedUrl.href,
    );
  }
}

function logDirectFallback(mcpServer: McpServer): void {
  logMessage(
    mcpServer,
    "warning",
    "Browser solver session acquisition failed; using the direct URL fetch path.",
  );
}

function createSolverRequestOptions(
  config: BrowserSolverConfig,
  requestedUrl: URL,
  signal: AbortSignal,
): RequestInit {
  const requestOptions: RequestInit = {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      cmd: "request.get",
      url: requestedUrl.href,
      maxTimeout: config.wireTimeout,
      returnOnlyCookies: true,
    }),
  };
  applyTrustedServiceRequestConfig(requestOptions, config.endpoint.href);
  return requestOptions;
}

function isPersistentClientError(status: number): boolean {
  return status >= 400
    && status < 500
    && status !== 408
    && status !== 429;
}

async function readSolverResponse(
  response: Response,
  maximumBytes: number,
): Promise<string | null> {
  if (isPersistentClientError(response.status)) {
    await response.body?.cancel();
    throw createConfigurationError(
      "Browser solver endpoint rejected the request. Check the configured endpoint and service API compatibility.",
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    return null;
  }
  return await readBoundedResponse(response, maximumBytes);
}

async function requestBrowserSolverSession(
  config: BrowserSolverConfig,
  requestedUrl: URL,
  signal?: AbortSignal,
): Promise<string | null> {
  const timeoutSignal = AbortSignal.timeout(config.timeoutMs + BROWSER_SOLVER_RESPONSE_GRACE_MS);
  const requestSignal = signal
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal;

  try {
    const response = await (undiciFetch as unknown as typeof fetch)(
      config.endpoint,
      createSolverRequestOptions(config, requestedUrl, requestSignal),
    );
    return await readSolverResponse(response, config.maxResponseBytes);
  } catch (error: any) {
    if (signal?.aborted) {
      throw signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
    }
    if (error?.name === "MCPSearXNGError") {
      throw error;
    }
    return null;
  }
}

function decodeSolution(responseText: string | null): BrowserSolverSolution | null {
  if (responseText === null) {
    return null;
  }
  try {
    return parseSolution(JSON.parse(responseText));
  } catch {
    return null;
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
  }
}

function tryReserveProviderSlot(
  mcpServer: McpServer,
  config: BrowserSolverConfig,
): boolean {
  if (activeSolverRequests[config.provider] < config.maxConcurrentRequests) {
    activeSolverRequests[config.provider]++;
    return true;
  }
  logMessage(
    mcpServer,
    "warning",
    "Browser solver concurrency limit reached; using the direct URL fetch path.",
  );
  return false;
}

function classifyAcquisition(
  mcpServer: McpServer,
  responseText: string | null,
  requestedUrl: URL,
): BrowserSolverAcquisition {
  const solution = decodeSolution(responseText);
  if (!solution) {
    logDirectFallback(mcpServer);
    return { kind: "fallback", reason: "unavailable" };
  }
  validateSolutionUrl(solution, requestedUrl);
  return { kind: "solved", solution };
}

export async function acquireBrowserSolverSolution(
  mcpServer: McpServer,
  config: BrowserSolverConfig,
  requestedUrl: URL,
  signal?: AbortSignal,
): Promise<BrowserSolverAcquisition> {
  throwIfAborted(signal);
  if (!tryReserveProviderSlot(mcpServer, config)) {
    return { kind: "fallback", reason: "busy" };
  }

  try {
    const responseText = await requestBrowserSolverSession(config, requestedUrl, signal);
    throwIfAborted(signal);
    return classifyAcquisition(mcpServer, responseText, requestedUrl);
  } finally {
    activeSolverRequests[config.provider]--;
  }
}

function cookiePath(cookie: BrowserSolverCookie): string {
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
  cookie: BrowserSolverCookie,
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
  cookie: BrowserSolverCookie;
  index: number;
  path: string;
}

function isUnexpired(cookie: BrowserSolverCookie, nowSeconds: number): boolean {
  return typeof cookie.expires !== "number"
    || !Number.isFinite(cookie.expires)
    || cookie.expires <= 0
    || cookie.expires > nowSeconds;
}

interface NamedCookie extends BrowserSolverCookie {
  name: string;
  value: string;
}

function hasCookieIdentity(cookie: BrowserSolverCookie): cookie is NamedCookie {
  return typeof cookie.name === "string" && typeof cookie.value === "string";
}

function cookieTransportMatches(
  cookie: BrowserSolverCookie,
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

export function buildBrowserSolverHeaders(
  solution: BrowserSolverSolution,
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

export function createBrowserSolverCacheKey(
  provider: BrowserSolverProvider,
  requestedUrl: string,
): string {
  return `solver:${provider}:${requestedUrl}`;
}
