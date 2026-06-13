import { getCurrentLogLevel } from "./logging.js";
import { packageVersion } from "./version.js";
import { getHttpSecurityConfig } from "./http-security.js";

export function createConfigResource() {
  const security = getHttpSecurityConfig();
  const showFullConfig = !security.harden || security.exposeFullConfig;

  const config = {
    serverInfo: {
      name: "ihor-sokoliuk/mcp-searxng",
      version: packageVersion,
      description: "MCP server for SearXNG integration"
    },
    environment: {
      ...(showFullConfig
        ? { searxngUrl: process.env.SEARXNG_URL || "(not configured)" }
        : { searxngUrlConfigured: !!process.env.SEARXNG_URL }),
      hasAuth: !!(process.env.AUTH_USERNAME && process.env.AUTH_PASSWORD),
      hasProxy: !!(process.env.HTTP_PROXY || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.https_proxy),
      hasNoProxy: !!(process.env.NO_PROXY || process.env.no_proxy),
      nodeVersion: process.version,
      currentLogLevel: getCurrentLogLevel()
    },
    capabilities: {
      tools: [
        "searxng_web_search",
        "searxng_search_suggestions",
        "searxng_instance_info",
        "web_url_read"
      ],
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
This is a Model Context Protocol (MCP) server that provides web search, autocomplete suggestions, instance capability discovery, and URL content reading through SearXNG.

## Available Tools

### 1. searxng_web_search
Performs web searches using the configured SearXNG instance.

**Parameters:**
- \`query\` (required): The search query string
- \`pageno\` (optional): Page number (default: 1)
- \`time_range\` (optional): Filter by time - "day", "week", "month", or "year"
- \`language\` (optional): Language code like "en", "fr", "de" (default: "all")
- \`safesearch\` (optional): Safe search level - 0 (none), 1 (moderate), 2 (strict)
- \`min_score\` (optional): Minimum relevance score from 0.0 to 1.0
- \`num_results\` (optional): Maximum result count from 1 to 20
- \`categories\` (optional): Comma-separated SearXNG categories such as "news" or "it,science"
- \`engines\` (optional): Comma-separated SearXNG engine names such as "google,bing,ddg"
- \`response_format\` (optional): "text" for formatted output or "json" for raw SearXNG-shaped JSON

Text output can include metadata sections for direct answers, spelling corrections, suggestions, and infoboxes before the result list. JSON output preserves the SearXNG response shape with filtered and sliced \`results\`.

### 2. searxng_search_suggestions
Returns autocomplete suggestions from the configured SearXNG instance.

**Parameters:**
- \`query\` (required): Partial or complete query to autocomplete
- \`language\` (optional): Language code like "en", "fr", "de" or "all" (default: "all")

### 3. searxng_instance_info
Discovers categories, engines, defaults, locales, and plugins exposed by the configured SearXNG instance.

**Parameters:**
- \`includeEngines\` (optional): Include enabled engine names
- \`includeDisabled\` (optional): Include disabled engine names when \`includeEngines\` is true
- \`category\` (optional): Filter categories and engines to one category
- \`refresh\` (optional): Bypass the process cache and fetch fresh \`/config\` data

### 4. web_url_read
Reads and converts web page content to Markdown format.

**Parameters:**
- \`url\` (required): The URL to fetch and convert
- \`startChar\` (optional): Starting character position
- \`maxLength\` (optional): Maximum number of characters to return
- \`section\` (optional): Extract content under a heading
- \`paragraphRange\` (optional): Return a paragraph range such as "1-5" or "10-"
- \`readHeadings\` (optional): Return only headings

## Configuration

### Required Environment Variables
- \`SEARXNG_URL\`: URL of your SearXNG instance (e.g., http://localhost:8080)

### Optional Environment Variables
- \`AUTH_USERNAME\` & \`AUTH_PASSWORD\`: Basic authentication for SearXNG
- \`HTTP_PROXY\` / \`HTTPS_PROXY\`: Proxy server configuration
- \`NO_PROXY\` / \`no_proxy\`: Comma-separated list of hosts to bypass proxy
- \`MCP_HTTP_PORT\`: Enable HTTP transport on specified port
- \`MCP_HTTP_ALLOW_PRIVATE_URLS\`: Allow \`web_url_read\` to fetch private/internal URLs. Disabled by default in all modes.

### URL Reader Security
\`web_url_read\` blocks private/internal URLs and redirects to private/internal URLs by default. Set \`MCP_HTTP_ALLOW_PRIVATE_URLS=true\` only when internal URL reads are intentional.

## Transport Modes

### STDIO (Default)
Standard input/output transport for desktop clients like Claude Desktop.

### HTTP (Optional)
RESTful HTTP transport for web applications. Set \`MCP_HTTP_PORT\` to enable.

### Hardened HTTP Mode (Optional)
Default behavior remains compatible for existing deployments.
For network-exposed HTTP transport, enable:
- \`MCP_HTTP_HARDEN\`
- \`MCP_HTTP_AUTH_TOKEN\`
- \`MCP_HTTP_ALLOWED_ORIGINS\`

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

### Get query suggestions
\`\`\`
Tool: searxng_search_suggestions
Args: {"query": "typescr"}
\`\`\`

### Discover instance capabilities
\`\`\`
Tool: searxng_instance_info
Args: {"includeEngines": true}
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
