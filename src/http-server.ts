import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { randomUUID } from "crypto";
import { createMcpHandler, isInitializeRequest, isLegacyRequest, type McpServer } from "@modelcontextprotocol/server";
import { NodeStreamableHTTPServerTransport, toNodeHandler, toWebRequest } from "@modelcontextprotocol/node";
import { logMessage } from "./logging.js";
import { packageVersion } from "./version.js";
import {
  sanitizeDiagnosticText,
  sanitizeDiagnosticValue,
  sanitizeErrorForTransport,
} from "./diagnostic-sanitizer.js";
import { writeDiagnostic } from "./diagnostic-output.js";
import { parseStrictInteger } from "./env-int.js";
import {
  getHttpSecurityConfig,
  isOriginAllowed,
  isRequestAuthorized,
  validateHttpSecurityConfig,
} from "./http-security.js";

interface Session {
  transport: NodeStreamableHTTPServerTransport;
  mcpServer: McpServer;
}

export const DEFAULT_STATELESS_MAX_IN_FLIGHT = 16;
export const DEFAULT_STATELESS_MAX_IN_FLIGHT_PER_IP = 8;
export const DEFAULT_STATELESS_REQUEST_TIMEOUT_MS = 900000;
export const MAX_STATELESS_MAX_IN_FLIGHT = 256;
const MIN_STATELESS_REQUEST_TIMEOUT_MS = 1000;
const MAX_STATELESS_REQUEST_TIMEOUT_MS = 2147483647;
const STATELESS_CLEANUP_DEADLINE_MS = 5000;
const STATELESS_WARNING_INTERVAL_MS = 60000;
const MODERN_PROTOCOL_VERSION = "2026-07-28";

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function modernRequestWithClaim(body: unknown): Record<string, unknown> | undefined {
  const request = objectRecord(body);
  if (!request || request.jsonrpc !== "2.0" || typeof request.method !== "string") return undefined;
  const params = objectRecord(request.params);
  const meta = objectRecord(params?._meta);
  if (meta?.["io.modelcontextprotocol/protocolVersion"] !== MODERN_PROTOCOL_VERSION) return undefined;
  return request;
}

function echoableRequestId(request: Record<string, unknown>): string | number | null | undefined {
  if (!Object.hasOwn(request, "id")) return undefined;
  const id = request.id;
  if (typeof id === "string" || id === null) return id;
  return typeof id === "number" && Number.isFinite(id) ? id : undefined;
}

/**
 * Temporary PR-2594 compatibility guard. Remove after a patched stable server
 * release is installed and its SDK-owned HeaderMismatch response is regression-tested.
 */
export function missingModernProtocolHeaderError(
  headers: Record<string, string | string[] | undefined>,
  body: unknown,
): { id: string | number | null; error: { code: number; message: string; data: object } } | undefined {
  if (headers["mcp-protocol-version"] !== undefined) return undefined;
  const request = modernRequestWithClaim(body);
  if (!request) return undefined;
  const id = echoableRequestId(request);
  if (id === undefined) return undefined;
  const bodyMessage = "the body envelope names protocol version 2026-07-28 but the required MCP-Protocol-Version header is absent";
  return {
    id,
    error: {
      code: -32020,
      message: `Bad Request: the request headers and body disagree: ${bodyMessage}`,
      data: { mismatch: { header: "(missing)", body: bodyMessage } },
    },
  };
}

export interface StatelessHttpConfig {
  enabled: boolean;
  maxInFlight: number;
  maxInFlightPerIp: number;
  requestTimeoutMs: number;
}

function warnDiagnostic(message: string, data?: unknown): void {
  if (data === undefined) {
    writeDiagnostic("warn", sanitizeDiagnosticText(message));
    return;
  }
  writeDiagnostic(
    "warn",
    sanitizeDiagnosticText(message),
    sanitizeDiagnosticValue(data),
  );
}

/**
 * Resolves the bind host from the MCP_HTTP_HOST environment variable.
 * Falls back to "127.0.0.1" (localhost only) when the variable is absent or whitespace-only.
 * Set MCP_HTTP_HOST=0.0.0.0 to expose on all interfaces (e.g. Docker, remote access).
 */
export function resolveBindHost(envValue: string | undefined): string {
  const trimmed = envValue?.trim();
  if (!trimmed) {
    return "127.0.0.1";
  }
  return trimmed;
}

/**
 * Parses a positive-integer rate-limit setting from the environment.
 * Absent/blank → fallback silently. Present-but-invalid or non-positive →
 * fallback plus a one-line console.warn so an operator typo cannot silently
 * disable rate limiting (a fail-open control). Uses console.warn, not the MCP
 * logMessage path, because makeRateLimiters runs without an McpServer in scope.
 */
export function parseRateLimitEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const parsed = parseStrictInteger(raw);
  if (parsed === undefined || parsed <= 0) {
    warnDiagnostic(
      `⚠️  Ignoring invalid ${name}. Expected a positive integer. Using default ${fallback}.`,
    );
    return fallback;
  }
  return parsed;
}

function parseBoundedStatelessEnv(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const parsed = parseStrictInteger(raw);
  if (parsed === undefined || parsed < minimum || parsed > maximum) {
    warnDiagnostic(
      `⚠️  Ignoring invalid ${name}. Expected an integer from ${minimum} through ${maximum}. Using default ${fallback}.`,
    );
    return fallback;
  }
  return parsed;
}

function resolveStatelessEnabled(): boolean {
  const raw = process.env.MCP_HTTP_STATELESS;
  const value = raw?.trim();
  if (!value || value === "false") return false;
  if (value === "true") return true;
  warnDiagnostic(
    "⚠️  Ignoring invalid MCP_HTTP_STATELESS. Expected true or false. Using false.",
  );
  return false;
}

export function resolveStatelessHttpConfig(): StatelessHttpConfig {
  const maxInFlight = parseBoundedStatelessEnv(
    "MCP_HTTP_STATELESS_MAX_IN_FLIGHT",
    DEFAULT_STATELESS_MAX_IN_FLIGHT,
    1,
    MAX_STATELESS_MAX_IN_FLIGHT,
  );
  const requestedPerIp = parseBoundedStatelessEnv(
    "MCP_HTTP_STATELESS_MAX_IN_FLIGHT_PER_IP",
    DEFAULT_STATELESS_MAX_IN_FLIGHT_PER_IP,
    1,
    MAX_STATELESS_MAX_IN_FLIGHT,
  );
  const maxInFlightPerIp = Math.min(requestedPerIp, maxInFlight);
  if (requestedPerIp > maxInFlight) {
    warnDiagnostic(
      `⚠️  Ignoring invalid MCP_HTTP_STATELESS_MAX_IN_FLIGHT_PER_IP. Expected a value no greater than MCP_HTTP_STATELESS_MAX_IN_FLIGHT. Using ${maxInFlight}.`,
    );
  }
  const requestTimeoutMs = parseBoundedStatelessEnv(
    "MCP_HTTP_STATELESS_REQUEST_TIMEOUT_MS",
    DEFAULT_STATELESS_REQUEST_TIMEOUT_MS,
    MIN_STATELESS_REQUEST_TIMEOUT_MS,
    MAX_STATELESS_REQUEST_TIMEOUT_MS,
  );

  return {
    enabled: resolveStatelessEnabled(),
    maxInFlight,
    maxInFlightPerIp,
    requestTimeoutMs,
  };
}

function makeRateLimiters() {
  const windowMs = parseRateLimitEnv("MCP_RATE_WINDOW_MS", 60000);

  const initLimiter = rateLimit({
    windowMs,
    max: parseRateLimitEnv("MCP_RATE_INIT_MAX", 20),
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      jsonrpc: "2.0",
      error: { code: -32029, message: "Too many requests" },
      id: null,
    },
  });

  const sessionLimiter = rateLimit({
    windowMs,
    max: parseRateLimitEnv("MCP_RATE_SESSION_MAX", 300),
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      jsonrpc: "2.0",
      error: { code: -32029, message: "Too many requests" },
      id: null,
    },
  });

  const healthLimiter = rateLimit({
    windowMs: 60000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
  });

  return { initLimiter, sessionLimiter, healthLimiter };
}

export async function createHttpServer(
  createMcpServer: (modern?: boolean) => McpServer,
  port?: number
): Promise<express.Application> {
  const app = express();
  const security = getHttpSecurityConfig(port);
  const stateless = resolveStatelessHttpConfig();
  validateHttpSecurityConfig(security);
  if (security.trustProxy !== false) {
    app.set('trust proxy', security.trustProxy);
  }

  const originBoundary: express.RequestHandler = (req, res, next) => {
    if (!isOriginAllowed(req.headers.origin, security)) {
      res.status(403).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Invalid Origin header" },
        id: null,
      });
      return;
    }
    next();
  };

  app.use('/mcp', originBoundary);
  app.use((_req, res, next) => {
    res.vary('Origin');
    next();
  });
  app.use(express.json());
  
  // Add CORS support for web clients
  app.use(cors({
    origin: (origin, callback) => {
      if (isOriginAllowed(origin, security)) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
    exposedHeaders: ["Mcp-Session-Id", "Mcp-Protocol-Version", "Mcp-Method", "Mcp-Name"],
    allowedHeaders: ["Content-Type", "mcp-session-id", "authorization", "mcp-protocol-version", "mcp-method", "mcp-name"],
  }));

  function rejectUnauthorized(res: express.Response) {
    res.status(401).json({
      jsonrpc: "2.0",
      error: {
        code: -32001,
        message: "Unauthorized: missing or invalid HTTP auth token",
      },
      id: null,
    });
  }

  function rejectInvalidHostHeader(
    req: express.Request,
    res: express.Response,
  ): boolean {
    if (!security.enableDnsRebindingProtection) {
      return false;
    }
    const host = req.headers.host;
    if (security.allowedHosts.length > 0 && (!host || !security.allowedHosts.includes(host))) {
      res.status(403).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Invalid Host header" },
        id: null,
      });
      return true;
    }
    return false;
  }

  function rejectInvalidPost(
    req: express.Request,
    res: express.Response,
    sessionId: string | undefined,
  ) {
    warnDiagnostic(`⚠️  POST request rejected - invalid request:`, {
      clientIP: req.ip || req.socket.remoteAddress,
      sessionId: sessionId || 'undefined',
      hasInitializeRequest: isInitializeRequest(req.body),
      userAgent: req.headers['user-agent'],
      contentType: req.headers['content-type'],
      accept: req.headers['accept']
    });
    const hasSessionId = Boolean(sessionId);
    res.status(hasSessionId ? 404 : 400).json({
      jsonrpc: '2.0',
      error: {
        code: hasSessionId ? -32001 : -32000,
        message: hasSessionId ? 'Session not found' : 'Bad Request: No valid session ID provided',
      },
      id: null,
    });
  }

  async function handleTransportRequest(
    transport: NodeStreamableHTTPServerTransport,
    req: express.Request,
    res: express.Response,
  ) {
    try {
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      if (error instanceof Error && error.message.includes('accept')) {
        warnDiagnostic(`⚠️  Connection rejected due to missing headers:`, {
          clientIP: req.ip || req.socket.remoteAddress,
          userAgent: req.headers['user-agent'],
          contentType: req.headers['content-type'],
          accept: req.headers['accept'],
          error: error.message
        });
      }
      throw sanitizeErrorForTransport(error);
    }
  }

  const { initLimiter, sessionLimiter, healthLimiter } = makeRateLimiters();

  // Map to store sessions by session ID
  const sessions = new Map<string, Session>();
  let statelessInFlight = 0;
  const statelessInFlightByIp = new Map<string, number>();
  let lastCapacityWarningAt = 0;
  let suppressedCapacityWarnings = 0;

  function resolvedClientIp(req: express.Request): string {
    return req.ip || req.socket.remoteAddress || "unknown";
  }

  function warnStatelessCapacity(reason: "per-ip" | "global"): void {
    const now = Date.now();
    if (now - lastCapacityWarningAt < STATELESS_WARNING_INTERVAL_MS) {
      suppressedCapacityWarnings += 1;
      return;
    }
    warnDiagnostic("⚠️  Stateless HTTP capacity exhausted.", {
      reason,
      inFlight: statelessInFlight,
      maxInFlight: stateless.maxInFlight,
      suppressedSinceLastWarning: suppressedCapacityWarnings,
    });
    lastCapacityWarningAt = now;
    suppressedCapacityWarnings = 0;
  }

  function admitStatelessRequest(
    req: express.Request,
    res: express.Response,
  ): (() => void) | undefined {
    const clientIp = resolvedClientIp(req);
    const clientInFlight = statelessInFlightByIp.get(clientIp) ?? 0;
    const reason = clientInFlight >= stateless.maxInFlightPerIp
      ? "per-ip"
      : statelessInFlight >= stateless.maxInFlight
        ? "global"
        : undefined;
    if (reason) {
      warnStatelessCapacity(reason);
      res.set("Retry-After", "1").status(503).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Server busy" },
        id: null,
      });
      return undefined;
    }

    statelessInFlight += 1;
    statelessInFlightByIp.set(clientIp, clientInFlight + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      statelessInFlight -= 1;
      const remaining = (statelessInFlightByIp.get(clientIp) ?? 1) - 1;
      if (remaining <= 0) statelessInFlightByIp.delete(clientIp);
      else statelessInFlightByIp.set(clientIp, remaining);
    };
  }

  const postRateLimiter: express.RequestHandler = (req, res, next) => {
    if (stateless.enabled) {
      const selectedLimiter = isInitializeRequest(req.body)
        ? initLimiter
        : sessionLimiter;
      selectedLimiter(req, res, next);
      return;
    }
    const sessionId = req.headers['mcp-session-id'];
    const claimsModernProtocol = req.headers['mcp-protocol-version'] === MODERN_PROTOCOL_VERSION
      || modernRequestWithClaim(req.body) !== undefined;
    // Node comma-joins duplicate custom headers. Only one exact live session ID
    // on a retained legacy request selects the generous bucket. Modern requests
    // are sessionless and cannot borrow capacity through a legacy session header.
    const selectedLimiter = !claimsModernProtocol
      && typeof sessionId === 'string'
      && sessions.has(sessionId)
      ? sessionLimiter
      : initLimiter;
    selectedLimiter(req, res, next);
  };

  // Handle POST requests for client-to-server communication
  app.post('/mcp', postRateLimiter, async (req, res) => {
    if (!isRequestAuthorized(req.headers.authorization as string | undefined, security)) {
      rejectUnauthorized(res);
      return;
    }

    if (rejectInvalidHostHeader(req, res)) return;

    if (!req.is("application/json")) {
      res.status(415).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Unsupported Media Type" },
        id: null,
      });
      return;
    }

    const modern = !(await isLegacyRequest(await toWebRequest(req, req.body), req.body));
    if (modern) {
      const headerError = missingModernProtocolHeaderError(req.headers, req.body);
      if (headerError) {
        res.status(400).json({ jsonrpc: "2.0", ...headerError });
        return;
      }
      const releaseCapacity = admitStatelessRequest(req, res);
      if (!releaseCapacity) return;
      const handler = createMcpHandler(() => createMcpServer(true), { legacy: "reject" });
      let requestTimer: NodeJS.Timeout | undefined;
      let cleanupPromise: Promise<void> | undefined;
      let requestTimedOut = false;
      const cleanup = (): Promise<void> => {
        if (cleanupPromise) return cleanupPromise;
        cleanupPromise = (async () => {
          if (requestTimer) clearTimeout(requestTimer);
          let cleanupDeadline: NodeJS.Timeout | undefined;
          try {
            await Promise.race([
              handler.close(),
              new Promise<never>((_resolve, reject) => {
                cleanupDeadline = setTimeout(
                  () => reject(new Error("Stateless resource cleanup timed out")),
                  STATELESS_CLEANUP_DEADLINE_MS,
                );
                cleanupDeadline.unref();
              }),
            ]);
          } catch (error) {
            warnDiagnostic("⚠️  Stateless HTTP cleanup did not complete normally.", error);
          } finally {
            if (cleanupDeadline) clearTimeout(cleanupDeadline);
            releaseCapacity();
          }
        })();
        return cleanupPromise;
      };
      const handleTimeout = (): void => {
        if (requestTimedOut) return;
        requestTimedOut = true;
        if (!res.headersSent && !res.destroyed) {
          res.status(504).json({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Stateless request timed out" },
            id: null,
          });
        } else if (!res.destroyed) {
          res.destroy();
        }
        void cleanup();
      };
      res.once("finish", () => { void cleanup(); });
      res.once("close", () => { void cleanup(); });
      requestTimer = setTimeout(handleTimeout, stateless.requestTimeoutMs);
      requestTimer.unref();
      try {
        await toNodeHandler(handler)(req, res, req.body);
        await cleanup();
      } catch (error) {
        await cleanup();
        if (requestTimedOut) return;
        throw error;
      }
      return;
    }

    if (stateless.enabled) {
      const releaseCapacity = admitStatelessRequest(req, res);
      if (!releaseCapacity) return;

      let mcpServer: McpServer | undefined;
      let transport: NodeStreamableHTTPServerTransport | undefined;
      let requestTimer: NodeJS.Timeout | undefined;
      let cleanupPromise: Promise<void> | undefined;
      let requestTimedOut = false;
      const requestDeadline = Date.now() + stateless.requestTimeoutMs;
      const cleanup = (): Promise<void> => {
        if (cleanupPromise) return cleanupPromise;
        cleanupPromise = (async () => {
          if (requestTimer) clearTimeout(requestTimer);
          const closeResources = async () => {
            const errors: unknown[] = [];
            try {
              await transport?.close();
            } catch (error) {
              errors.push(error);
            }
            try {
              await mcpServer?.close();
            } catch (error) {
              errors.push(error);
            }
            if (errors.length) throw new AggregateError(errors, "Stateless resource cleanup failed");
          };
          let cleanupDeadline: NodeJS.Timeout | undefined;
          try {
            await Promise.race([
              closeResources(),
              new Promise<never>((_resolve, reject) => {
                cleanupDeadline = setTimeout(
                  () => reject(new Error("Stateless resource cleanup timed out")),
                  STATELESS_CLEANUP_DEADLINE_MS,
                );
                cleanupDeadline.unref();
              }),
            ]);
          } catch (error) {
            warnDiagnostic("⚠️  Stateless HTTP cleanup did not complete normally.", error);
          } finally {
            if (cleanupDeadline) clearTimeout(cleanupDeadline);
            releaseCapacity();
          }
        })();
        return cleanupPromise;
      };
      const handleStatelessTimeout = (): void => {
        if (requestTimedOut) return;
        requestTimedOut = true;
        warnDiagnostic("⚠️  Stateless HTTP request reached its lifetime limit.", {
          timeoutMs: stateless.requestTimeoutMs,
        });
        if (!res.headersSent && !res.destroyed) {
          res.status(504).json({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Stateless request timed out" },
            id: null,
          });
        } else if (!res.destroyed) {
          res.destroy();
        }
        void cleanup();
      };
      const cleanupAfterResponse = () => {
        void cleanup();
      };
      res.once('finish', cleanupAfterResponse);
      res.once('close', cleanupAfterResponse);
      requestTimer = setTimeout(handleStatelessTimeout, stateless.requestTimeoutMs);
      requestTimer.unref();
      try {
        mcpServer = createMcpServer();
        transport = new NodeStreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableDnsRebindingProtection: security.enableDnsRebindingProtection,
          allowedHosts: security.allowedHosts,
          allowedOrigins: security.allowedOrigins,
        });
        if (Date.now() >= requestDeadline) {
          handleStatelessTimeout();
          await cleanup();
          return;
        }
        await mcpServer.connect(transport);
        await handleTransportRequest(transport, req, res);
      } catch (error) {
        await cleanup();
        if (requestTimedOut) return;
        throw error;
      }
      return;
    }

    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    let transport: NodeStreamableHTTPServerTransport;
    let mcpServer: McpServer;

    if (sessionId && sessions.has(sessionId)) {
      // Reuse existing session
      const session = sessions.get(sessionId)!;
      transport = session.transport;
      mcpServer = session.mcpServer;
      logMessage(mcpServer, "debug", `Reusing session: ${sessionId}`);
    } else if (isInitializeRequest(req.body)) {
      // New initialization request — create fresh McpServer and transport
      mcpServer = createMcpServer();

      transport = new NodeStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sessionId) => {
          sessions.set(sessionId, { transport, mcpServer });
          logMessage(mcpServer, "debug", `Session initialized: ${sessionId}`);
        },
        enableDnsRebindingProtection: security.enableDnsRebindingProtection,
        allowedHosts: security.allowedHosts,
        allowedOrigins: security.allowedOrigins,
      });

      // Clean up session when transport closes
      transport.onclose = () => {
        if (transport.sessionId) {
          sessions.delete(transport.sessionId);
        }
      };

      // Connect this session's McpServer to its transport
      await mcpServer.connect(transport);
    } else {
      rejectInvalidPost(req, res, sessionId);
      return;
    }

    await handleTransportRequest(transport, req, res);
  });

  // Handle GET requests for server-to-client notifications via SSE
  app.get('/mcp', sessionLimiter, async (req, res) => {
    if (!isRequestAuthorized(req.headers.authorization as string | undefined, security)) {
      rejectUnauthorized(res);
      return;
    }

    if (stateless.enabled) {
      if (rejectInvalidHostHeader(req, res)) {
        return;
      }
      res.set('Allow', 'POST').status(405).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method not allowed' },
        id: null,
      });
      return;
    }

    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !sessions.has(sessionId)) {
      warnDiagnostic(`⚠️  GET request rejected - missing or invalid session ID:`, {
        clientIP: req.ip || req.socket.remoteAddress,
        sessionId: sessionId || 'undefined',
        userAgent: req.headers['user-agent']
      });
      res.status(400).send('Invalid or missing session ID');
      return;
    }

    const session = sessions.get(sessionId)!;
    try {
      await session.transport.handleRequest(req, res);
    } catch (error) {
      warnDiagnostic(`⚠️  GET request failed:`, {
        clientIP: req.ip || req.socket.remoteAddress,
        sessionId,
        error: error instanceof Error ? error.message : String(error)
      });
      throw sanitizeErrorForTransport(error);
    }
  });

  // Handle DELETE requests for session termination
  app.delete('/mcp', sessionLimiter, async (req, res) => {
    if (!isRequestAuthorized(req.headers.authorization as string | undefined, security)) {
      rejectUnauthorized(res);
      return;
    }

    if (stateless.enabled) {
      if (rejectInvalidHostHeader(req, res)) {
        return;
      }
      res.set('Allow', 'POST').status(405).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method not allowed' },
        id: null,
      });
      return;
    }

    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !sessions.has(sessionId)) {
      warnDiagnostic(`⚠️  DELETE request rejected - missing or invalid session ID:`, {
        clientIP: req.ip || req.socket.remoteAddress,
        sessionId: sessionId || 'undefined',
        userAgent: req.headers['user-agent']
      });
      res.status(400).send('Invalid or missing session ID');
      return;
    }

    const session = sessions.get(sessionId)!;
    try {
      await session.transport.handleRequest(req, res);
    } catch (error) {
      warnDiagnostic(`⚠️  DELETE request failed:`, {
        clientIP: req.ip || req.socket.remoteAddress,
        sessionId,
        error: error instanceof Error ? error.message : String(error)
      });
      throw sanitizeErrorForTransport(error);
    } finally {
      sessions.delete(sessionId);
    }
  });

  // Health check endpoint
  app.get('/health', healthLimiter, (_req, res) => {
    res.json({ 
      status: 'healthy',
      server: 'ihor-sokoliuk/mcp-searxng',
      version: packageVersion,
      transport: 'http'
    });
  });

  // Express catches rejected async route handlers here. Keep this after every
  // route so session creation/connect failures cannot fall through to
  // Express's development error page, which includes the raw stack.
  app.use((
    error: unknown,
    _req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    const safeError = sanitizeErrorForTransport(error);
    warnDiagnostic("HTTP request failed:", safeError);
    if (res.headersSent) {
      next(safeError);
      return;
    }
    res.status(500).json({
      jsonrpc: "2.0",
      error: {
        code: -32603,
        message: "Internal server error",
      },
      id: null,
    });
  });

  return app;
}
