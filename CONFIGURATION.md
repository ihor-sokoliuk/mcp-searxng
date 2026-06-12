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

## Timeouts

| Variable | Required | Default | Description |
|---|---|---|---|
| `SEARXNG_TIMEOUT_MS` | No | `10000` | Maximum time in milliseconds to wait for a SearXNG search response. The request is aborted and a network error is returned if the server does not respond within this window. |

## Search Result Controls

| Variable | Required | Default | Description |
|---|---|---|---|
| `SEARXNG_MAX_RESULTS` | No | — | Operator-level maximum number of search results to return per call (1-20). Invalid values are ignored. Recommended: `10` for smaller context windows. |
| `SEARXNG_MAX_RESULT_CHARS` | No | — | Maximum characters to include in each search result snippet. Longer snippets are truncated and marked with `…`. Invalid values are ignored. Recommended: `500` for smaller context windows. |

## URL Reader Controls

| Variable | Required | Default | Description |
|---|---|---|---|
| `URL_READ_MAX_CHARS` | No | — | Default maximum characters returned by `web_url_read` when the caller omits `maxLength`. Explicit `maxLength` always wins. Invalid values are ignored. |
| `URL_READ_MAX_CONTENT_LENGTH_BYTES` | No | `5242880` | Maximum `Content-Length` allowed by the `web_url_read` HEAD preflight before downloading a page. Invalid values fall back to the default. HEAD failures are non-fatal and the GET proceeds. |

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
| `MCP_HTTP_HOST` | No | `127.0.0.1` | Interface address to bind to. Defaults to localhost-only for security. Set `0.0.0.0` for all interfaces (required for Docker and remote deployments), or a specific IP. **Breaking change from v1.2.1:** previous default was `0.0.0.0`. |

**HTTP endpoints (when HTTP mode is active):**
- `POST/GET/DELETE /mcp` — MCP protocol
- `GET /health` — health check

## Rate Limiting (HTTP mode)

Rate limiting is always active in HTTP mode to prevent resource exhaustion. Two separate limits protect different request types.

| Variable | Required | Default | Description |
|---|---|---|---|
| `MCP_RATE_WINDOW_MS` | No | `60000` | Sliding window duration in milliseconds for all rate limits |
| `MCP_RATE_INIT_MAX` | No | `20` | Max POST `/mcp` requests per window (applied to all POSTs, guards against session-init flooding) |
| `MCP_RATE_SESSION_MAX` | No | `300` | Max GET/DELETE `/mcp` requests per window (per-session calls; intentionally generous for AI agents) |

Requests exceeding a limit receive HTTP 429 with a JSON-RPC error body (`code: -32029`). `/health` has a fixed limit of 60 requests per minute. Standard `RateLimit-*` headers are included on all responses.

The in-memory store is per-process; for horizontally scaled deployments replace it with a shared Redis store via `express-rate-limit`'s `store` option.

## Hardened HTTP Mode

Opt-in security layer for when you expose the HTTP transport on a network. Default HTTP behavior is unchanged — hardening must be explicitly enabled with `MCP_HTTP_HARDEN=true`.

| Variable | Required | Default | Description |
|---|---|---|---|
| `MCP_HTTP_HARDEN` | No | `false` | Set to `true` to enable all hardening features |
| `MCP_HTTP_AUTH_TOKEN` | No | — | Required bearer token for all HTTP requests in hardened mode |
| `MCP_HTTP_ALLOWED_ORIGINS` | No | — | Comma-separated CORS origin allowlist (e.g. `https://app.example.com`) |
| `MCP_HTTP_ALLOWED_HOSTS` | No | — | Comma-separated DNS rebinding protection allowlist override |
| `MCP_HTTP_ALLOW_PRIVATE_URLS` | No | `false` | Allow `web_url_read` to fetch internal/private URLs. Private URL reads are blocked by default in all modes. |
| `MCP_HTTP_EXPOSE_FULL_CONFIG` | No | `false` | Expose full config details in `/health` response (for debugging) |

## URL Reader Security

`web_url_read` blocks private/internal URLs by default in all transport modes. This includes localhost, loopback addresses, private IPv4 ranges, link-local addresses, `0.0.0.0/8`, IPv6 loopback/ULA/link-local addresses, and IPv4-mapped IPv6 private addresses.

Redirects are also checked before they are followed. A public URL that redirects to a private/internal URL is blocked.

Set `MCP_HTTP_ALLOW_PRIVATE_URLS=true` only when internal URL reads are intentional for your deployment.


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
        "SEARXNG_TIMEOUT_MS": "10000",
        "SEARXNG_MAX_RESULTS": "10",
        "SEARXNG_MAX_RESULT_CHARS": "500",
        "URL_READ_MAX_CHARS": "2000",
        "URL_READ_MAX_CONTENT_LENGTH_BYTES": "5242880",
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
        "MCP_HTTP_HOST": "0.0.0.0",
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
