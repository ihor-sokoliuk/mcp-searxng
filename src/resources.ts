import { getCurrentLogLevel } from "./logging.js";
import { packageVersion } from "./index.js";

export function createConfigResource() {
  const config = {
    serverInfo: {
      name: "ihor-sokoliuk/mcp-searxng",
      version: packageVersion,
      description: "MCP server for SearXNG integration"
    },
    environment: {
      searxngUrl: process.env.SEARXNG_URL || "(not configured)",
      hasAuth: !!(process.env.AUTH_USERNAME && process.env.AUTH_PASSWORD),
      hasProxy: !!(process.env.HTTP_PROXY || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.https_proxy),
      hasNoProxy: !!(process.env.NO_PROXY || process.env.no_proxy),
      nodeVersion: process.version,
      currentLogLevel: getCurrentLogLevel()
    },
    capabilities: {
      tools: ["searxng_web_search", "web_url_read"],
      logging: true,
      resources: true,
      transports: process.env.MCP_HTTP_PORT ? ["stdio", "http"] : ["stdio"]
    }
  };

  return JSON.stringify(config, null, 2);
}

export function createHelpResource() {
  return `# SearXNG MCP Server Help

## Overview
This is a Model Context Protocol (MCP) server that provides web search capabilities through SearXNG and URL content reading functionality.

## Available Tools

### 1. searxng_web_search
Performs web searches using the configured SearXNG instance.

**Parameters:**
- \`query\` (required): The search query string
- \`pageno\` (optional): Page number (default: 1)
- \`time_range\` (optional): Filter by time - "day", "month", or "year"
- \`language\` (optional): Language code like "en", "fr", "de" (default: "all")
- \`safesearch\` (optional): Safe search level - "0" (none), "1" (moderate), "2" (strict)

### 2. web_url_read
Reads and converts web page content to Markdown format.

**Parameters:**
- \`url\` (required): The URL to fetch and convert

## Configuration

### Required Environment Variables
- \`SEARXNG_URL\`: URL of your SearXNG instance (e.g., http://localhost:8080)

### Optional Environment Variables
- \`AUTH_USERNAME\` & \`AUTH_PASSWORD\`: Basic authentication for SearXNG
- \`HTTP_PROXY\` / \`HTTPS_PROXY\`: Proxy server configuration
- \`NO_PROXY\` / \`no_proxy\`: Comma-separated list of hosts to bypass proxy
- \`MCP_HTTP_PORT\`: Enable HTTP transport on specified port

## Transport Modes

### STDIO (Default)
Standard input/output transport for desktop clients like Claude Desktop.

### HTTP (Optional)
RESTful HTTP transport for web applications. Set \`MCP_HTTP_PORT\` to enable.

## Usage Examples

### Search for recent news
\`\`\`
Tool: searxng_web_search
Args: {"query": "latest AI developments", "time_range": "day"}
\`\`\`

### Read a specific article
\`\`\`
Tool: web_url_read  
Args: {"url": "https://example.com/article"}
\`\`\`

## Troubleshooting

1. **"SEARXNG_URL not set"**: Configure the SEARXNG_URL environment variable
2. **Network errors**: Check if SearXNG is running and accessible
3. **Empty results**: Try different search terms or check SearXNG instance
4. **Timeout errors**: The server has a 10-second timeout for URL fetching

Use logging level "debug" for detailed request information.

## Current Configuration
See the "Current Configuration" resource for live settings.
`;
}
