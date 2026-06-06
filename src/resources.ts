import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { logMessage } from "./logging.js";

export function createConfigResource(): string {
  const config = {
    version: process.env.npm_package_version || "unknown",
    environment: process.env.NODE_ENV || "development",
    searxngUrl: process.env.SEARXNG_URL || "not configured",
    logLevel: process.env.LOG_LEVEL || "info",
    cacheTimeout: process.env.CACHE_TIMEOUT_MS || "not configured",
    port: process.env.PORT || "3000",
    timestamp: new Date().toISOString(),
  };
  return JSON.stringify(config, null, 2);
}

export function createHelpResource(): string {
  return `# MCP SearXNG Server - Usage Guide

## Overview
This MCP server provides web search capabilities through SearXNG.

## Available Tools

### 1. searxng_web_search
Performs web searches using the configured SearXNG instance.

**Parameters:**
- \`query\` (required): The search query string
- \`pageno\` (optional): Search page number (starts at 1, default: 1)
- \`time_range\` (optional): Filter by time - "day", "month", or "year"
- \`language\` (optional): Language code like "en", "fr", "de" (default: "all")
- \`safesearch\` (optional): Safe search level - 0 (none), 1 (moderate), 2 (strict)
- \`engines\` (optional): Target specific search engines (e.g., ["google", "bing"])
- \`categories\` (optional): Filter by category (e.g., ["general", "news"])

**Example:**
\`\`\`json
{
  "query": "climate change",
  "engines": ["google", "wikipedia"],
  "categories": ["news"],
  "time_range": "month"
}
\`\`\`

### 2. web_url_read
Reads and converts web page content to Markdown format.

**Parameters:**
- \`url\` (required): The URL to fetch
- \`startChar\` (optional): Starting character position (default: 0)
- \`maxLength\` (optional): Maximum characters to return
- \`section\` (optional): Extract content under specific heading
- \`paragraphRange\` (optional): Return specific paragraph ranges (e.g., "1-5")
- \`readHeadings\` (optional): Return only headings list

**Example:**
\`\`\`json
{
  "url": "https://example.com/article",
  "section": "Introduction",
  "maxLength": 5000
}
\`\`\`

## Configuration

Set these environment variables:

- **SEARXNG_URL** (required): URL of your SearXNG instance
- LOG_LEVEL: Logging level (debug, info, warn, error)
- AUTH_USERNAME / AUTH_PASSWORD: Basic auth credentials (optional)
- USER_AGENT: Custom User-Agent header (optional)
- CACHE_TIMEOUT_MS: URL cache timeout in milliseconds (optional)
- NODE_ENV: Environment (development/production)

## Tips

1. Use \`pageno\` to retrieve different result pages
2. Combine \`time_range\` and \`language\` to narrow results
3. Use \`engines\` parameter to target specific search providers
4. After search, use \`web_url_read\` to fetch full page content
5. The \`section\` parameter in \`web_url_read\` helps extract relevant content quickly

## Troubleshooting

- **"No SEARXNG_URL configured"**: Set the SEARXNG_URL environment variable
- **"403 Forbidden"**: SearXNG instance may have JSON disabled in settings.yml
- **No results**: Try different search terms or check engine availability
- **Timeout**: Large pages may take time; use \`maxLength\` to limit response size
`;
}
