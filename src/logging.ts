import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { LoggingLevel } from "@modelcontextprotocol/sdk/types.js";

// Logging state
let currentLogLevel: LoggingLevel = "info";

// Logging helper function
export function logMessage(server: Server, level: LoggingLevel, message: string, data?: unknown): void {
  if (shouldLog(level)) {
    try {
      server.notification({
        method: "notifications/message",
        params: {
          level,
          message,
          data
        }
      }).catch((error) => {
        // Silently ignore "Not connected" errors during server startup
        // This can happen when logging occurs before the transport is fully connected
        if (error instanceof Error && error.message !== "Not connected") {
          console.error("Logging error:", error);
        }
      });
    } catch (error) {
      // Handle synchronous errors as well
      if (error instanceof Error && error.message !== "Not connected") {
        console.error("Logging error:", error);
      }
    }
  }
}

export function shouldLog(level: LoggingLevel): boolean {
  const levels: LoggingLevel[] = ["debug", "info", "warning", "error"];
  return levels.indexOf(level) >= levels.indexOf(currentLogLevel);
}

export function setLogLevel(level: LoggingLevel): void {
  currentLogLevel = level;
}

export function getCurrentLogLevel(): LoggingLevel {
  return currentLogLevel;
}
