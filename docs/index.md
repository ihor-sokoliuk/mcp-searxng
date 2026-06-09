# mcp-searxng Documentation

## User Guides

- **[README](../README.md)** — Quick start, installation, tool reference, and troubleshooting
- **[CONFIGURATION](../CONFIGURATION.md)** — All environment variables with defaults and examples

## Topics

### Installation
See [README § Installation](../README.md#installation) for setup instructions for Claude Desktop, Cursor, VS Code, and Docker.

### Configuration
See [CONFIGURATION.md](../CONFIGURATION.md) for all supported environment variables:
- `SEARXNG_URL` — SearXNG instance URL (required)
- `MCP_HTTP_PORT` / `MCP_HTTP_HOST` — HTTP transport settings
- `MCP_HTTP_AUTH_TOKEN` — Bearer token authentication
- `MCP_RATE_*` — Rate limiting controls
- `HTTPS_PROXY` / `NO_PROXY` — Proxy settings

### Tools
See [README § Tools](../README.md#tools) for the `searxng_web_search` and `web_url_read` tool reference.

### Security
See [SECURITY.md](../SECURITY.md) for the vulnerability reporting policy.
