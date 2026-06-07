# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 1.x (latest) | ✅ |
| < 1.0 | ❌ |

Security fixes are released as patch versions on the `main` branch. Only the latest published version receives security updates.

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Report vulnerabilities privately via [GitHub Security Advisories](https://github.com/ihor-sokoliuk/mcp-searxng/security/advisories/new).

Please include:

- A description of the vulnerability and its potential impact
- Steps to reproduce or a proof-of-concept
- Affected version(s) and configuration
- Any suggested mitigations

You can expect an acknowledgement within **72 hours** and a status update within **7 days**. If a fix is warranted, a patch will be released as soon as practical and a CVE requested if applicable.

## Threat Model

`mcp-searxng` is a **Node.js MCP server** that runs as a local process (STDIO) or network service (HTTP transport). It brokers requests between an AI assistant and a SearXNG instance, and optionally fetches and converts arbitrary URLs to Markdown.

The primary security surface areas are:

| Area | Risk |
|------|------|
| `web_url_read` tool | SSRF — the server fetches user-supplied URLs on behalf of the AI |
| HTTP transport | Unauthorized access, DNS rebinding, CORS misconfiguration |
| Proxy credentials | Credential exposure in environment variables |
| SearXNG credentials | `AUTH_PASSWORD` in environment |
| Query forwarding | Search queries are forwarded verbatim to SearXNG |

## Security Features

### SSRF Protection (`web_url_read`)

Private and internal URLs are **blocked by default** in all transport modes. The following are rejected:

- `localhost` and `*.localhost`
- IPv4 loopback (`127.0.0.0/8`), private (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), link-local (`169.254.0.0/16`), and unspecified (`0.0.0.0/8`) ranges
- IPv6 loopback (`::1`), unspecified (`::`), ULA (`fc00::/7`), link-local (`fe80::/10`)
- IPv4-mapped IPv6 addresses that resolve to any of the above (e.g. `::ffff:127.0.0.1`)
- Redirects are validated **before** they are followed — a public URL that redirects to a private address is also blocked

To allow private URL reads (e.g. for internal deployments), set `MCP_HTTP_ALLOW_PRIVATE_URLS=true`. Do this only when internal fetching is intentional.

### Hardened HTTP Mode

When `MCP_HTTP_PORT` is set, the server exposes an HTTP endpoint. By default it has no authentication. Enable hardened mode for any network-accessible deployment:

```
MCP_HTTP_HARDEN=true
MCP_HTTP_AUTH_TOKEN=<strong-random-token>
MCP_HTTP_ALLOWED_ORIGINS=https://your-app.example.com
```

Hardened mode enforces:

- **Bearer token authentication** on every request (`Authorization: Bearer <token>`)
- **CORS origin allowlist** — requests from unlisted origins are rejected
- **DNS rebinding protection** — `Host` header is validated against `MCP_HTTP_ALLOWED_HOSTS` (defaults to `127.0.0.1,localhost`)

`MCP_HTTP_HARDEN=true` will fail to start if `MCP_HTTP_AUTH_TOKEN` or `MCP_HTTP_ALLOWED_ORIGINS` are missing.

### Transport Security

STDIO mode (default) is the most secure deployment: the server communicates only over stdin/stdout with the parent process — no network socket is opened, no authentication is needed.

For HTTP mode, bind to `127.0.0.1` unless external access is required:

```
MCP_HTTP_HOST=127.0.0.1
```

The default bind address is `0.0.0.0` (all interfaces), which exposes the port on the network.

### TLS and CA Certificates

The server auto-detects system CA bundles on Linux and macOS for outbound HTTPS connections. On Windows, set `NODE_EXTRA_CA_CERTS` to a PEM file if you need custom CAs. Custom CAs are applied to both the SearXNG connection and all `web_url_read` fetches.

### Redirect Handling

The `web_url_read` tool manually follows redirects (up to 5 hops). Each intermediate URL is validated against the private-IP blocklist before the request is made.

## Deployment Recommendations

### Minimal / Local

Use the default STDIO transport. No additional configuration is needed beyond `SEARXNG_URL`.

### Internal Network (HTTP)

```
MCP_HTTP_HOST=127.0.0.1   # bind to loopback only
MCP_HTTP_PORT=3000
```

### Public / Internet-Facing (HTTP)

```
MCP_HTTP_HARDEN=true
MCP_HTTP_HOST=127.0.0.1             # put a reverse proxy in front
MCP_HTTP_AUTH_TOKEN=<random-256bit>
MCP_HTTP_ALLOWED_ORIGINS=https://your-app.example.com
MCP_HTTP_ALLOWED_HOSTS=your-app.example.com
MCP_HTTP_ALLOW_PRIVATE_URLS=false   # default, keep this off
```

Place the server behind a TLS-terminating reverse proxy (nginx, Caddy, Traefik). Do not expose the MCP HTTP port directly to the internet.

### Secrets in Environment Variables

`AUTH_PASSWORD`, `MCP_HTTP_AUTH_TOKEN`, and proxy credentials are read from environment variables. Avoid committing these to source control. Use secret management (Docker secrets, environment injection at runtime, or a secrets manager) in production.

## Scope

The following are **in scope** for security reports:

- SSRF bypasses in `web_url_read` (IP parsing edge cases, redirect chain escapes, IPv6 encoding tricks)
- Authentication/authorization bypasses in HTTP transport
- DNS rebinding bypasses
- CORS misconfiguration allowing unintended cross-origin access
- Sensitive data leakage (credentials, tokens) in logs or HTTP responses
- Dependency vulnerabilities with a realistic exploitation path against this server

The following are **out of scope**:

- Vulnerabilities in SearXNG itself (report those to the [SearXNG project](https://github.com/searxng/searxng/security))
- Attacks requiring the attacker to already control the environment or process
- Denial-of-service via resource exhaustion (no SLA is implied)
- `MCP_HTTP_EXPOSE_FULL_CONFIG=true` leaking config — this is an explicit opt-in debugging flag

## Dependency Auditing

Run `npm run audit:deps` to check for known vulnerabilities in dependencies:

```bash
npm run audit:deps
# equivalent to: npm audit --audit-level=moderate
```

The `npm run security` script combines linting (including `eslint-plugin-security` rules) with the dependency audit.
