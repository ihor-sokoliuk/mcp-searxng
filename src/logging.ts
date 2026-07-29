import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { LoggingLevel } from "@modelcontextprotocol/sdk/types.js";
import {
  sanitizeDiagnosticText,
  sanitizeDiagnosticValue,
  sanitizeErrorForTransport,
} from "./diagnostic-sanitizer.js";
import { writeDiagnostic } from "./diagnostic-output.js";

export const DEFAULT_LOG_LEVEL: LoggingLevel = "info";
const logLevelsByServer = new WeakMap<McpServer, LoggingLevel>();

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

// Logging helper function
export function logMessage(mcpServer: McpServer, level: LoggingLevel, message: string, data?: unknown): void {
  if (shouldLog(mcpServer, level)) {
    try {
      const notificationData = data !== undefined
        ? (typeof data === 'object' && data !== null ? { message, ...data } : { message, data })
        : { message };

      mcpServer.sendLoggingMessage({
        level,
        data: sanitizeDiagnosticValue({
          ...notificationData,
          message: sanitizeDiagnosticText(message),
        }) as Record<string, unknown>,
      }).catch(handleSendError);
    } catch (error) {
      handleSendError(error);
    }
  }
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
