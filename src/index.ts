#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  SetLevelRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// Import modularized functionality
import { WEB_SEARCH_TOOL, READ_URL_TOOL, isSearXNGWebSearchArgs } from "./types.js";
import { logMessage, setLogLevel, getCurrentLogLevel } from "./logging.js";
import { performWebSearch } from "./search.js";
import { fetchAndConvertToMarkdown } from "./url-reader.js";
import { createConfigResource, createHelpResource } from "./resources.js";
import { createHttpServer } from "./http-server.js";

// Use a static version string that will be updated by the version script
const packageVersion = "1.0.2";

// Export the version for use in other modules
export { packageVersion };

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

/**
 * Creates and configures a new McpServer with all handlers registered.
 * Called once per HTTP session, or once for STDIO mode.
 */
export function createMcpServer(): McpServer {
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

  const server = mcpServer.server;

  // List tools handler
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    logMessage(mcpServer, "debug", "Handling list_tools request");
    return {
      tools: [WEB_SEARCH_TOOL, READ_URL_TOOL],
    };
  });

  // Call tool handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    logMessage(mcpServer, "debug", `Handling call_tool request: ${name}`);

    try {
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
          args.safesearch
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

        const paginationOptions = {
          startChar: args.startChar,
          maxLength: args.maxLength,
          section: args.section,
          paragraphRange: args.paragraphRange,
          readHeadings: args.readHeadings,
        };

        const result = await fetchAndConvertToMarkdown(mcpServer, args.url, 10000, paginationOptions);

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
      logMessage(mcpServer, "error", `Tool execution error: ${error instanceof Error ? error.message : String(error)}`, { 
        tool: name, 
        args: args,
        error: error instanceof Error ? error.stack : String(error)
      });
      throw error;
    }
  });

  // Logging level handler
  server.setRequestHandler(SetLevelRequestSchema, async (request) => {
    const { level } = request.params;
    logMessage(mcpServer, "info", `Setting log level to: ${level}`);
    setLogLevel(level);
    return {};
  });

  // List resources handler
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    logMessage(mcpServer, "debug", "Handling list_resources request");
    return {
      resources: [
        {
          uri: "config://server-config",
          mimeType: "application/json",
          name: "Server Configuration",
          description: "Current server configuration and environment variables"
        },
        {
          uri: "help://usage-guide",
          mimeType: "text/markdown",
          name: "Usage Guide",
          description: "How to use the MCP SearXNG server effectively"
        }
      ]
    };
  });

  // List resource templates handler
  // Returns empty list — required by MCP spec even when no templates exist
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
    logMessage(mcpServer, "debug", "Handling list_resource_templates request");
    return { resourceTemplates: [] };
  });

  // Read resource handler
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;
    logMessage(mcpServer, "debug", `Handling read_resource request for: ${uri}`);

    switch (uri) {
      case "config://server-config":
        return {
          contents: [
            {
              uri: uri,
              mimeType: "application/json",
              text: createConfigResource()
            }
          ]
        };

      case "help://usage-guide":
        return {
          contents: [
            {
              uri: uri,
              mimeType: "text/markdown",
              text: createHelpResource()
            }
          ]
        };

      default:
        throw new Error(`Unknown resource: ${uri}`);
    }
  });

  return mcpServer;
}

// Main function
async function main() {
  // Check for HTTP transport mode
  const httpPort = process.env.MCP_HTTP_PORT;
  if (httpPort) {
    const port = parseInt(httpPort, 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      console.error(`Invalid HTTP port: ${httpPort}. Must be between 1-65535.`);
      process.exit(1);
    }

    console.log(`Starting HTTP transport on port ${port}`);
    const app = await createHttpServer(createMcpServer);
    
    const httpServer = app.listen(port, () => {
      console.log(`HTTP server listening on port ${port}`);
      console.log(`Health check: http://localhost:${port}/health`);
      console.log(`MCP endpoint: http://localhost:${port}/mcp`);
    });

    // Handle graceful shutdown
    const shutdown = (signal: string) => {
      console.log(`Received ${signal}. Shutting down HTTP server...`);
      httpServer.close(() => {
        console.log("HTTP server closed");
        process.exit(0);
      });
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  } else {
    // Default STDIO transport — single session, single server
    const mcpServer = createMcpServer();

    // Show helpful message when running in terminal
    if (process.stdin.isTTY) {
      console.error(`🔍 MCP SearXNG Server v${packageVersion} - Ready`);
      if (process.env.SEARXNG_URL) {
        console.error(`🌐 SearXNG URL: ${process.env.SEARXNG_URL}`);
      } else {
        console.error("⚠️  SEARXNG_URL not set — configure it before using search tools");
      }
      console.error("📡 Waiting for MCP client connection via STDIO...\n");
    }
    
    const transport = new StdioServerTransport();
    await mcpServer.connect(transport);
    
    // Log after connection is established
    logMessage(mcpServer, "info", `MCP SearXNG Server v${packageVersion} connected via STDIO`);
    logMessage(mcpServer, "info", `Log level: ${getCurrentLogLevel()}`);
    logMessage(mcpServer, "info", `Environment: ${process.env.NODE_ENV || 'development'}`);
    logMessage(mcpServer, "info", `SearXNG URL: ${process.env.SEARXNG_URL || 'not configured'}`);
  }
}

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

// Start the server (CLI entrypoint)
main().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
