import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { LoggingLevel } from "@modelcontextprotocol/sdk/types.js";
import {
  sanitizeDiagnosticText,
  sanitizeDiagnosticValue,
  sanitizeErrorForTransport,
} from "./diagnostic-sanitizer.js";
import { writeDiagnostic } from "./diagnostic-output.js";

// Logging state
let currentLogLevel: LoggingLevel = "info";

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
  if (shouldLog(level)) {
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

export function shouldLog(level: LoggingLevel): boolean {
  return LOG_LEVELS.indexOf(level) >= LOG_LEVELS.indexOf(currentLogLevel);
}

export function setLogLevel(level: LoggingLevel): void {
  currentLogLevel = level;
}

export function getCurrentLogLevel(): LoggingLevel {
  return currentLogLevel;
}
