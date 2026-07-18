import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { randomUUID } from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { logMessage } from "./logging.js";
import { packageVersion } from "./version.js";
import {
  getHttpSecurityConfig,
  isOriginAllowed,
  isRequestAuthorized,
  validateHttpSecurityConfig,
} from "./http-security.js";

interface Session {
  transport: StreamableHTTPServerTransport;
  mcpServer: McpServer;
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
 * Absent/blank → fallback silently. Present-but-invalid (NaN or <= 0) →
 * fallback plus a one-line console.warn so an operator typo cannot silently
 * disable rate limiting (a fail-open control). Uses console.warn, not the MCP
 * logMessage path, because makeRateLimiters runs without an McpServer in scope.
 */
export function parseRateLimitEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    console.warn(
      `⚠️  Ignoring invalid ${name}="${raw}". Expected a positive integer. Using default ${fallback}.`,
    );
    return fallback;
  }
  return parsed;
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
  createMcpServer: () => McpServer,
  port?: number
): Promise<express.Application> {
  const app = express();
  const security = getHttpSecurityConfig(port);
  validateHttpSecurityConfig(security);
  if (security.trustProxy !== false) {
    app.set('trust proxy', security.trustProxy);
  }

  app.use(express.json());
  
  // Add CORS support for web clients
  app.use(cors({
    origin: (origin, callback) => {
      if (isOriginAllowed(origin || undefined, security)) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
    exposedHeaders: ["Mcp-Session-Id"],
    allowedHeaders: ["Content-Type", "mcp-session-id", "authorization", "mcp-protocol-version"],
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

  function rejectInvalidPost(
    req: express.Request,
    res: express.Response,
    sessionId: string | undefined,
  ) {
    console.warn(`⚠️  POST request rejected - invalid request:`, {
      clientIP: req.ip || req.socket.remoteAddress,
      sessionId: sessionId || 'undefined',
      hasInitializeRequest: isInitializeRequest(req.body),
      userAgent: req.headers['user-agent'],
      contentType: req.headers['content-type'],
      accept: req.headers['accept']
    });
    const sessionNotFound = Boolean(sessionId);
    res.status(sessionNotFound ? 404 : 400).json({
      jsonrpc: '2.0',
      error: {
        code: sessionNotFound ? -32001 : -32000,
        message: sessionNotFound ? 'Session not found' : 'Bad Request: No valid session ID provided',
      },
      id: null,
    });
  }

  async function handleTransportRequest(
    transport: StreamableHTTPServerTransport,
    req: express.Request,
    res: express.Response,
  ) {
    try {
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      if (error instanceof Error && error.message.includes('accept')) {
        console.warn(`⚠️  Connection rejected due to missing headers:`, {
          clientIP: req.ip || req.socket.remoteAddress,
          userAgent: req.headers['user-agent'],
          contentType: req.headers['content-type'],
          accept: req.headers['accept'],
          error: error.message
        });
      }
      throw error;
    }
  }

  const { initLimiter, sessionLimiter, healthLimiter } = makeRateLimiters();

  // Map to store sessions by session ID
  const sessions = new Map<string, Session>();

  const postRateLimiter: express.RequestHandler = (req, res, next) => {
    const sessionId = req.headers['mcp-session-id'];
    // Node comma-joins duplicate custom headers. Only one exact live session ID
    // selects the generous bucket; every other value stays initialization-limited.
    const selectedLimiter = typeof sessionId === 'string' && sessions.has(sessionId)
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

    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    let transport: StreamableHTTPServerTransport;
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

      transport = new StreamableHTTPServerTransport({
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

    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !sessions.has(sessionId)) {
      console.warn(`⚠️  GET request rejected - missing or invalid session ID:`, {
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
      console.warn(`⚠️  GET request failed:`, {
        clientIP: req.ip || req.socket.remoteAddress,
        sessionId,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  });

  // Handle DELETE requests for session termination
  app.delete('/mcp', sessionLimiter, async (req, res) => {
    if (!isRequestAuthorized(req.headers.authorization as string | undefined, security)) {
      rejectUnauthorized(res);
      return;
    }

    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !sessions.has(sessionId)) {
      console.warn(`⚠️  DELETE request rejected - missing or invalid session ID:`, {
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
      console.warn(`⚠️  DELETE request failed:`, {
        clientIP: req.ip || req.socket.remoteAddress,
        sessionId,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
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

  return app;
}
