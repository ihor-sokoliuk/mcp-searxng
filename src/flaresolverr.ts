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

function parseSolution(value: unknown): FlareSolverrSolution | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const envelope = value as Record<string, unknown>;
  if (envelope.status !== "ok") {
    return null;
  }
  const rawSolution = envelope.solution;
  if (!rawSolution || typeof rawSolution !== "object" || Array.isArray(rawSolution)) {
    return null;
  }
  const solution = rawSolution as Record<string, unknown>;
  if (
    typeof solution.url !== "string"
    || typeof solution.status !== "number"
    || !Number.isInteger(solution.status)
    || !Array.isArray(solution.cookies)
    || typeof solution.userAgent !== "string"
    || solution.userAgent.trim() === ""
  ) {
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
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.timeoutMs);
    let responseText: string | null;

    try {
      const requestOptions: RequestInit = {
        method: "POST",
        signal: controller.signal,
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
      if (
        response.status >= 400
        && response.status < 500
        && response.status !== 408
        && response.status !== 429
      ) {
        await response.body?.cancel();
        throw createConfigurationError(
          "FlareSolverr endpoint rejected the request. Check FLARESOLVERR_URL and service API compatibility.",
        );
      }
      if (!response.ok) {
        await response.body?.cancel();
        logDirectFallback(mcpServer);
        return { kind: "fallback", reason: "unavailable" };
      }
      responseText = await readBoundedResponse(response);
    } catch (error: any) {
      if (error?.name === "MCPSearXNGError") {
        throw error;
      }
      logDirectFallback(mcpServer);
      return { kind: "fallback", reason: "unavailable" };
    } finally {
      clearTimeout(timeoutId);
    }

    if (responseText === null) {
      logDirectFallback(mcpServer);
      return { kind: "fallback", reason: "unavailable" };
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(responseText);
    } catch {
      logDirectFallback(mcpServer);
      return { kind: "fallback", reason: "unavailable" };
    }

    const solution = parseSolution(decoded);
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

export function buildFlareSolverrHeaders(
  solution: FlareSolverrSolution,
  targetUrl: URL,
  nowSeconds: number = Date.now() / 1000,
): Record<string, string> {
  const requestHostname = targetUrl.hostname.toLowerCase();
  const solutionHostname = new URL(solution.url).hostname.toLowerCase();
  const matches = solution.cookies
    .map((cookie, index) => ({ cookie, index, path: cookiePath(cookie) }))
    .filter(({ cookie, path }) => (
      requestHostname === solutionHostname
      && typeof cookie.name === "string"
      && cookie.name !== ""
      && typeof cookie.value === "string"
      && domainMatches(cookie, requestHostname, solutionHostname)
      && pathMatches(targetUrl.pathname || "/", path)
      && (cookie.secure !== true || targetUrl.protocol === "https:")
      && !(
        typeof cookie.expires === "number"
        && Number.isFinite(cookie.expires)
        && cookie.expires > 0
        && cookie.expires <= nowSeconds
      )
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
