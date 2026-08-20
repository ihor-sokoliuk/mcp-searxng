/* eslint-disable @typescript-eslint/no-deprecated -- legacy MCP logging remains required for the 2025-era transport. */
import { AsyncLocalStorage } from "node:async_hooks";
import { McpServer, type LoggingLevel } from "@modelcontextprotocol/server";
import {
  sanitizeDiagnosticText,
  sanitizeDiagnosticValue,
  sanitizeErrorForTransport,
} from "./diagnostic-sanitizer.js";
import { writeDiagnostic } from "./diagnostic-output.js";

export const DEFAULT_LOG_LEVEL: LoggingLevel = "info";
const logLevelsByServer = new WeakMap<McpServer, LoggingLevel>();
const modernServers = new WeakSet<McpServer>();
const modernLogScope = new AsyncLocalStorage<(
  level: LoggingLevel,
  data: Record<string, unknown>,
) => Promise<void>>();
const MODERN_SCOPE_WARNING_INTERVAL_MS = 60_000;
let lastModernScopeWarningAt = 0;
let suppressedModernScopeWarnings = 0;

const LOG_LEVELS: LoggingLevel[] = [
  "debug",
  "info",
  "notice",
  "warning",
  "error",
  "critical",
  "alert",
  "emergency",
];

// Shared handler for sendLoggingMessage errors
function handleSendError(error: unknown): void {
  if (error instanceof Error && error.message !== "Not connected") {
    writeDiagnostic("error", "Logging error:", sanitizeErrorForTransport(error));
  }
}

function warnModernScopeDrop(): void {
  const now = Date.now();
  if (now - lastModernScopeWarningAt < MODERN_SCOPE_WARNING_INTERVAL_MS) {
    suppressedModernScopeWarnings += 1;
    return;
  }
  writeDiagnostic(
    "error",
    "Dropped an MCP log outside its modern request scope.",
    { suppressedSinceLastWarning: suppressedModernScopeWarnings },
  );
  lastModernScopeWarningAt = now;
  suppressedModernScopeWarnings = 0;
}

// Logging helper function
export function logMessage(mcpServer: McpServer, level: LoggingLevel, message: string, data?: unknown): void {
  const scopedLog = modernLogScope.getStore();
  const modern = modernServers.has(mcpServer);
  if (!scopedLog && !modern && !shouldLog(mcpServer, level)) return;

  try {
    const notificationData = data !== undefined
      ? (typeof data === 'object' && data !== null ? { message, ...data } : { message, data })
      : { message };

    const safeData = sanitizeDiagnosticValue({
      ...notificationData,
      message: sanitizeDiagnosticText(message),
    }) as Record<string, unknown>;
    if (scopedLog) {
      // The SDK-provided request sink owns modern envelope-level filtering.
      scopedLog(level, safeData).catch(handleSendError);
      return;
    }
    if (modern) {
      warnModernScopeDrop();
      return;
    }
    mcpServer.sendLoggingMessage({
      level,
      data: safeData,
    }).catch(handleSendError);
  } catch (error) {
    handleSendError(error);
  }
}

export function markModernServer(mcpServer: McpServer): void {
  modernServers.add(mcpServer);
}

export function runWithModernLog<T>(
  log: (level: LoggingLevel, data: unknown, logger?: string) => Promise<void>,
  callback: () => Promise<T>,
): Promise<T> {
  return modernLogScope.run(log, callback);
}

export function shouldLog(mcpServer: McpServer, level: LoggingLevel): boolean {
  return LOG_LEVELS.indexOf(level) >= LOG_LEVELS.indexOf(getCurrentLogLevel(mcpServer));
}

export function setLogLevel(mcpServer: McpServer, level: LoggingLevel): void {
  logLevelsByServer.set(mcpServer, level);
}

export function getCurrentLogLevel(mcpServer?: McpServer): LoggingLevel {
  return mcpServer === undefined
    ? DEFAULT_LOG_LEVEL
    : (logLevelsByServer.get(mcpServer) ?? DEFAULT_LOG_LEVEL);
}
