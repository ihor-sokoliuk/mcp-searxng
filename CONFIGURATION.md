# Configuration Reference

All environment variables for `mcp-searxng`, organized by concern. All variables are optional unless marked required.

## Core

| Variable | Required | Default | Description |
|---|---|---|---|
| `SEARXNG_URL` | Yes | — | URL of your SearXNG instance. Format: `<protocol>://<hostname>[:<port>]` (e.g. `http://localhost:8080`) |

## Authentication

| Variable | Required | Default | Description |
|---|---|---|---|
| `AUTH_USERNAME` | No | — | HTTP Basic Auth username for password-protected SearXNG instances |
| `AUTH_PASSWORD` | No | — | HTTP Basic Auth password for password-protected SearXNG instances |

## User-Agent

| Variable | Required | Default | Description |
|---|---|---|---|
| `USER_AGENT` | No | — | Global User-Agent header for all outgoing requests (e.g. `MyBot/1.0`) |
| `URL_READER_USER_AGENT` | No | — | User-Agent for `web_url_read` only — overrides `USER_AGENT` for URL reads |

## Proxy

Interface-specific proxies take priority over global proxies for their respective tools.

| Variable | Required | Default | Description |
|---|---|---|---|
| `HTTP_PROXY` / `HTTPS_PROXY` | No | — | Global proxy for all traffic. Format: `http://[user:pass@]host:port` |
| `SEARCH_HTTP_PROXY` / `SEARCH_HTTPS_PROXY` | No | — | Proxy for `searxng_web_search` only |
| `URL_READER_HTTP_PROXY` / `URL_READER_HTTPS_PROXY` | No | — | Proxy for `web_url_read` only |
| `NO_PROXY` | No | — | Comma-separated bypass list (e.g. `localhost,.internal,example.com`) |

## HTTP Transport

By default the server communicates over STDIO. Set `MCP_HTTP_PORT` to enable HTTP mode instead.

| Variable | Required | Default | Description |
|---|---|---|---|
| `MCP_HTTP_PORT` | No | — | Port number to enable HTTP transport (e.g. `3000`) |

**HTTP endpoints (when HTTP mode is active):**
- `POST/GET/DELETE /mcp` — MCP protocol
- `GET /health` — health check

## Hardened HTTP Mode

Opt-in security layer for when you expose the HTTP transport on a network. Default HTTP behavior is unchanged — hardening must be explicitly enabled with `MCP_HTTP_HARDEN=true`.

| Variable | Required | Default | Description |
|---|---|---|---|
| `MCP_HTTP_HARDEN` | No | `false` | Set to `true` to enable all hardening features |
| `MCP_HTTP_AUTH_TOKEN` | No | — | Required bearer token for all HTTP requests in hardened mode |
| `MCP_HTTP_ALLOWED_ORIGINS` | No | — | Comma-separated CORS origin allowlist (e.g. `https://app.example.com`) |
| `MCP_HTTP_ALLOWED_HOSTS` | No | — | Comma-separated DNS rebinding protection allowlist override |
| `MCP_HTTP_ALLOW_PRIVATE_URLS` | No | `false` | Allow `web_url_read` to fetch internal/private URLs in hardened mode |
| `MCP_HTTP_EXPOSE_FULL_CONFIG` | No | `false` | Expose full config details in `/health` response (for debugging) |


## Full Example (All Options)

Complete MCP client configuration with every variable. Mix and match as needed — all optional variables can be used independently or together.

```json
{
  "mcpServers": {
    "searxng": {
      "command": "npx",
      "args": ["-y", "mcp-searxng"],
      "env": {
        "SEARXNG_URL": "YOUR_SEARXNG_INSTANCE_URL",
        "AUTH_USERNAME": "your_username",
        "AUTH_PASSWORD": "your_password",
        "USER_AGENT": "MyBot/1.0",
        "URL_READER_USER_AGENT": "Mozilla/5.0 (compatible; MyBot/1.0)",
        "SEARCH_HTTP_PROXY": "http://search-proxy.company.com:8080",
        "SEARCH_HTTPS_PROXY": "http://search-proxy.company.com:8080",
        "URL_READER_HTTP_PROXY": "http://reader-proxy.company.com:8080",
        "URL_READER_HTTPS_PROXY": "http://reader-proxy.company.com:8080",
        "HTTP_PROXY": "http://global-proxy.company.com:8080",
        "HTTPS_PROXY": "http://global-proxy.company.com:8080",
        "NO_PROXY": "localhost,127.0.0.1,.local,.internal",
        "MCP_HTTP_PORT": "3000",
        "MCP_HTTP_HARDEN": "true",
        "MCP_HTTP_AUTH_TOKEN": "replace-me",
        "MCP_HTTP_ALLOWED_ORIGINS": "https://app.example.com",
        "MCP_HTTP_ALLOWED_HOSTS": "app.example.com",
        "MCP_HTTP_ALLOW_PRIVATE_URLS": "false",
        "MCP_HTTP_EXPOSE_FULL_CONFIG": "false"
      }
    }
  }
}
```
