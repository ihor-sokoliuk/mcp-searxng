/* eslint-disable @typescript-eslint/no-deprecated -- the v2 request-scoped compatibility log bridge is required. */
import { McpServer, fromJsonSchema, type ReadResourceCallback } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

// Import modularized functionality
import {
  WEB_SEARCH_TOOL,
  SUGGESTIONS_TOOL,
  INSTANCE_INFO_TOOL,
  READ_URL_TOOL,
  LITE_WEB_SEARCH_TOOL,
  LITE_SUGGESTIONS_TOOL,
  LITE_INSTANCE_INFO_TOOL,
  LITE_READ_URL_TOOL,
  isSearXNGWebSearchArgs,
  isSearXNGSearchSuggestionsArgs,
  isSearXNGInstanceInfoArgs,
} from "./types.js";
import { logMessage, markModernServer, runWithModernLog, setLogLevel, getCurrentLogLevel } from "./logging.js";
import { performWebSearch } from "./search.js";
import { performSearchSuggestions } from "./suggestions.js";
import { fetchInstanceInfo } from "./instance-info.js";
import { fetchAndConvertToMarkdown } from "./url-reader.js";
import { createConfigResource, createHelpResource } from "./resources.js";
import { createHttpServer, resolveBindHost } from "./http-server.js";
import {
  getSearxngInstances,
  redactSearxngInstanceUrl,
} from "./searxng-instances.js";
import {
  initializeDiagnosticSanitizer,
  sanitizeErrorForTransport,
} from "./diagnostic-sanitizer.js";
import { writeDiagnostic } from "./diagnostic-output.js";
import { parseBoundedInteger, parseStrictInteger } from "./env-int.js";
import { validateBrowserSolverEnvironment } from "./browser-solver-config.js";

import { packageVersion } from "./version.js";

export const TOOL_ADMISSION_REJECTION_MESSAGE = "Server busy. Retry later with backoff.";

export interface ToolAdmissionConfig {
  rateWindowMs: number;
  rateMax: number;
  maxInFlight: number;
}

export interface ToolAdmissionResult {
  reason?: "rate" | "concurrency";
  release?: () => void;
}

/** SDK-neutral, process-local admission state shared by every MCP transport. */
export class ToolAdmissionController {
  private windowStartedAt: number | undefined;
  private rateCount = 0;
  private inFlight = 0;

  constructor(
    private readonly config: ToolAdmissionConfig,
    private readonly now: () => number = () => performance.now(),
  ) {}

  admit(): ToolAdmissionResult {
    const now = this.now();
    if (this.windowStartedAt === undefined || now - this.windowStartedAt >= this.config.rateWindowMs) {
      this.windowStartedAt = now;
      this.rateCount = 0;
    }

    if (this.rateCount >= this.config.rateMax) {
      return { reason: "rate" };
    }
    this.rateCount += 1;

    if (this.inFlight >= this.config.maxInFlight) {
      return { reason: "concurrency" };
    }
    this.inFlight += 1;

    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.inFlight -= 1;
      },
    };
  }
}

const TOOL_ADMISSION_ENV = [
  ["MCP_TOOL_RATE_WINDOW_MS", "rateWindowMs", 60000, 1000, 2147483647],
  ["MCP_TOOL_RATE_MAX", "rateMax", 300, 1, 10000],
  ["MCP_TOOL_MAX_IN_FLIGHT", "maxInFlight", 16, 1, 256],
] as const;

export function createToolAdmissionController(): ToolAdmissionController {
  const values: Record<string, number> = {};
  for (const [name, property, fallback, minimum, maximum] of TOOL_ADMISSION_ENV) {
    const parsed = parseBoundedInteger(process.env[name], fallback, minimum, maximum);
    if (parsed.invalid) {
      writeDiagnostic("warn", `Ignoring invalid ${name}. Using default ${fallback}.`);
    }
    values[property] = parsed.value;
  }
  return new ToolAdmissionController({
    rateWindowMs: values.rateWindowMs,
    rateMax: values.rateMax,
    maxInFlight: values.maxInFlight,
  });
}

// Type guard for URL reading args
export function isWebUrlReadArgs(args: unknown): args is {
  url: string;
  startChar?: number;
  maxLength?: number;
  section?: string;
  paragraphRange?: string;
  readHeadings?: boolean;
} {
  if (
    typeof args !== "object" ||
    args === null ||
    !("url" in args) ||
    typeof (args as { url: string }).url !== "string"
  ) {
    return false;
  }

  const urlArgs = args as any;

  // Convert empty strings to undefined for optional string parameters
  if (urlArgs.section === "") urlArgs.section = undefined;
  if (urlArgs.paragraphRange === "") urlArgs.paragraphRange = undefined;

  // Validate optional parameters
  if (urlArgs.startChar !== undefined && (typeof urlArgs.startChar !== "number" || urlArgs.startChar < 0)) {
    return false;
  }
  if (urlArgs.maxLength !== undefined && (typeof urlArgs.maxLength !== "number" || urlArgs.maxLength < 1)) {
    return false;
  }
  if (urlArgs.section !== undefined && typeof urlArgs.section !== "string") {
    return false;
  }
  if (urlArgs.paragraphRange !== undefined && typeof urlArgs.paragraphRange !== "string") {
    return false;
  }
  if (urlArgs.readHeadings !== undefined && typeof urlArgs.readHeadings !== "boolean") {
    return false;
  }

  return true;
}

function getFetchTimeoutMs(mcpServer: McpServer): number {
  const rawValue = process.env.FETCH_TIMEOUT_MS;
  if (rawValue === undefined || rawValue.trim() === "") {
    return 10000;
  }

  const parsed = parseStrictInteger(rawValue);
  if (parsed === undefined || parsed <= 0) {
    logMessage(
      mcpServer,
      "warning",
      `Ignoring invalid FETCH_TIMEOUT_MS="${rawValue}". Expected a positive integer. Using default 10000.`,
    );
    return 10000;
  }

  return parsed;
}

function getDefaultUrlReadMaxChars(mcpServer: McpServer): number | undefined {
  const rawValue = process.env.URL_READ_MAX_CHARS;
  if (rawValue === undefined || rawValue.trim() === "") {
    return undefined;
  }

  const parsed = parseStrictInteger(rawValue);
  if (parsed === undefined || parsed <= 0) {
    logMessage(
      mcpServer,
      "warning",
      `Ignoring invalid URL_READ_MAX_CHARS="${rawValue}". Expected a positive integer.`,
    );
    return undefined;
  }

  return parsed;
}

/**
 * Creates and configures a new McpServer with all handlers registered.
 * Called once per HTTP session, or once for STDIO mode.
 */
export function createMcpServer(admissionController: ToolAdmissionController, modern = false): McpServer {
  if (!admissionController) {
    throw new TypeError("Tool admission controller is required");
  }

  const mcpServer = new McpServer(
    {
      name: "ihor-sokoliuk/mcp-searxng",
      version: packageVersion,
    },
    {
      capabilities: {
        logging: {},
        resources: {},
        tools: {},
      },
    }
  );

  const useLiteTools = process.env.SEARXNG_LITE_TOOLS === "true";
  const searchTool = useLiteTools ? LITE_WEB_SEARCH_TOOL : WEB_SEARCH_TOOL;
  const suggestionsTool = useLiteTools ? LITE_SUGGESTIONS_TOOL : SUGGESTIONS_TOOL;
  const instanceInfoTool = useLiteTools ? LITE_INSTANCE_INFO_TOOL : INSTANCE_INFO_TOOL;
  const readUrlTool = useLiteTools ? LITE_READ_URL_TOOL : READ_URL_TOOL;

  type ToolCallResult = {
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
  };

  const callTool = async (name: string, args: unknown, signal?: AbortSignal): Promise<ToolCallResult> => {
    const admission = admissionController.admit();
    if (!admission.release) {
      return {
        content: [{ type: "text", text: TOOL_ADMISSION_REJECTION_MESSAGE }],
        isError: true,
      };
    }

    try {
      logMessage(mcpServer, "debug", `Handling call_tool request: ${name}`);

      if (name === "searxng_web_search") {
        if (!isSearXNGWebSearchArgs(args)) {
          throw new Error("Invalid arguments for web search");
        }

        const result = await performWebSearch(
          mcpServer,
          args.query,
          args.pageno,
          args.time_range,
          args.language,
          args.safesearch === undefined ? undefined : Number(args.safesearch),
          args.min_score,
          args.num_results,
          args.categories,
          args.engines,
          args.response_format,
          args.result_detail,
        );

        return {
          content: [
            {
              type: "text",
              text: result,
            },
          ],
        };
      } else if (name === "searxng_search_suggestions") {
        if (!isSearXNGSearchSuggestionsArgs(args)) {
          throw new Error("Invalid arguments for search suggestions");
        }

        const suggestions = await performSearchSuggestions(
          mcpServer,
          args.query,
          args.language,
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ query: args.query, suggestions }, null, 2),
            },
          ],
        };
      } else if (name === "searxng_instance_info") {
        if (!isSearXNGInstanceInfoArgs(args)) {
          throw new Error("Invalid arguments for instance info");
        }

        const result = await fetchInstanceInfo(
          mcpServer,
          args.includeEngines,
          args.includeDisabled,
          args.category,
          args.refresh,
        );

        return {
          content: [
            {
              type: "text",
              text: result,
            },
          ],
        };
      } else if (name === "web_url_read") {
        if (!isWebUrlReadArgs(args)) {
          throw new Error("Invalid arguments for URL reading");
        }

        const defaultMaxLength = getDefaultUrlReadMaxChars(mcpServer);
        const paginationOptions = {
          startChar: args.startChar,
          maxLength: args.maxLength ?? defaultMaxLength,
          section: args.section,
          paragraphRange: args.paragraphRange,
          readHeadings: args.readHeadings,
        };

        const result = await fetchAndConvertToMarkdown(
          mcpServer,
          args.url,
          getFetchTimeoutMs(mcpServer),
          paginationOptions,
          signal,
        );

        return {
          content: [
            {
              type: "text",
              text: result,
            },
          ],
        };
      } else {
        throw new Error(`Unknown tool: ${name}`);
      }
    } catch (error) {
      const safeError = sanitizeErrorForTransport(error);
      logMessage(mcpServer, "error", `Tool execution error: ${safeError.message}`, {
        tool: name, 
        args: args,
        error: safeError.stack,
      });
      throw safeError;
    } finally {
      admission.release();
    }
  };

  const registerTool = (tool: typeof WEB_SEARCH_TOOL) => {
    mcpServer.registerTool(
      tool.name,
      {
        description: tool.description,
        annotations: tool.annotations,
        inputSchema: fromJsonSchema(tool.inputSchema as Record<string, unknown>),
      },
      async (args, context) => (modern
        ? runWithModernLog(context.mcpReq.log, () => callTool(tool.name, args, context.mcpReq.signal))
        : callTool(tool.name, args, context.mcpReq.signal)),
    );
  };
  registerTool(searchTool);
  registerTool(suggestionsTool);
  registerTool(instanceInfoTool);
  registerTool(readUrlTool);
  if (!modern) {
    // Preserve the legacy wire error and admission boundary while the modern
    // era keeps SDK-owned schema validation and tool dispatch.
    mcpServer.server.setRequestHandler("tools/call", async (request, context) => (
      callTool(request.params.name, request.params.arguments, context.mcpReq.signal)
    ));
  }

  const readConfigResource: ReadResourceCallback = async (uri, context) => {
    const callback = async () => {
      logMessage(mcpServer, "debug", `Handling read_resource request for: ${uri.href}`);
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: createConfigResource(mcpServer) }] };
    };
    return modern ? runWithModernLog(context.mcpReq.log, callback) : callback();
  };
  const readHelpResource: ReadResourceCallback = async (uri, context) => {
    const callback = async () => {
      logMessage(mcpServer, "debug", `Handling read_resource request for: ${uri.href}`);
      return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: createHelpResource() }] };
    };
    return modern ? runWithModernLog(context.mcpReq.log, callback) : callback();
  };

  mcpServer.registerResource(
    "Server Configuration",
    "config://server-config",
    { mimeType: "application/json", description: "Current server configuration and environment variables" },
    readConfigResource,
  );
  if (modern) {
    markModernServer(mcpServer);
  }
  mcpServer.registerResource(
    "Usage Guide",
    "help://usage-guide",
    { mimeType: "text/markdown", description: "How to use the MCP SearXNG server effectively" },
    readHelpResource,
  );
  // Keep the credential-safe unknown-resource contract while delegating known
  // resources to the same request-scoped callbacks registered with the SDK.
  mcpServer.server.setRequestHandler("resources/read", async (request, context) => {
    if (request.params.uri === "config://server-config") {
      return readConfigResource(new URL(request.params.uri), context);
    }
    if (request.params.uri === "help://usage-guide") {
      return readHelpResource(new URL(request.params.uri), context);
    }
    throw sanitizeErrorForTransport(new Error(`Unknown resource: ${request.params.uri}`));
  });
  mcpServer.server.setRequestHandler("logging/setLevel", async (request, context) => {
    const callback = async () => {
      logMessage(mcpServer, "info", `Setting log level to: ${request.params.level}`);
      setLogLevel(mcpServer, request.params.level);
      return {};
    };
    return modern ? runWithModernLog(context.mcpReq.log, callback) : callback();
  });

  return mcpServer;
}

// Main function
export async function main() {
  initializeDiagnosticSanitizer();
  const toolAdmissionController = createToolAdmissionController();
  const browserSolverIssue = validateBrowserSolverEnvironment();
  if (browserSolverIssue) {
    throw new Error(browserSolverIssue);
  }

  // Check for HTTP transport mode
  const httpPort = process.env.MCP_HTTP_PORT;
  if (httpPort) {
    const port = parseStrictInteger(httpPort);
    if (port === undefined || port < 1 || port > 65535) {
      writeDiagnostic("error", `Invalid HTTP port: ${httpPort}. Must be between 1-65535.`);
      process.exit(1);
    }

    const host = resolveBindHost(process.env.MCP_HTTP_HOST);
    writeDiagnostic("log", `Starting HTTP transport on ${host}:${port}`);
    const app = await createHttpServer((modern) => createMcpServer(toolAdmissionController, modern), port);

    const httpServer = app.listen(port, host, () => {
      writeDiagnostic("log", `HTTP server listening on ${host}:${port}`);
      // Health/MCP URLs shown as localhost for developer convenience
      writeDiagnostic("log", `Health check: http://localhost:${port}/health`);
      writeDiagnostic("log", `MCP endpoint: http://localhost:${port}/mcp`);
    });

    // Handle graceful shutdown
    const shutdown = (signal: string) => {
      writeDiagnostic("log", `Received ${signal}. Shutting down HTTP server...`);
      httpServer.close(() => {
        writeDiagnostic("log", "HTTP server closed");
        process.exit(0);
      });
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  } else {
    // Keep connection setup diagnostics on stderr, including non-TTY clients.
    if (process.stdin.isTTY) {
      writeDiagnostic("error", `🔍 MCP SearXNG Server v${packageVersion} - Ready`);
      const searxngInstances = getSearxngInstances();
      if (searxngInstances.length > 0) {
        writeDiagnostic(
          "error",
          `🌐 SearXNG URLs: ${searxngInstances.map(redactSearxngInstanceUrl).join("; ")}`,
        );
      } else {
        writeDiagnostic("error", "⚠️  SEARXNG_URL not set — configure it before using search tools");
      }
      writeDiagnostic("error", "📡 Waiting for MCP client connection via STDIO...\n");
    } else {
      const searxngInstances = getSearxngInstances();
      if (searxngInstances.length > 0) {
        writeDiagnostic(
          "error",
          `SearXNG URLs: ${searxngInstances.map(redactSearxngInstanceUrl).join("; ")}`,
        );
      } else {
        writeDiagnostic("error", "SEARXNG_URL not set");
      }
    }

    serveStdio((context) => createMcpServer(toolAdmissionController, context.era === "modern"), {
      onerror: (error) => writeDiagnostic("error", sanitizeErrorForTransport(error)),
    });
  }
}
