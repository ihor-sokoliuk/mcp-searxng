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
| SearXNG credentials | Credentials in `SEARXNG_URL` userinfo or legacy `AUTH_PASSWORD` fallback |
| Query forwarding | Search queries are forwarded verbatim to SearXNG |

## Security Features

### SSRF Protection (`web_url_read`)

Private and internal URLs are **blocked by default** in all transport modes. The following are rejected:

- `localhost` and `*.localhost`
- IPv4 loopback (`127.0.0.0/8`), private (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), link-local (`169.254.0.0/16`), unspecified (`0.0.0.0/8`), CGNAT (`100.64.0.0/10`), IETF protocol assignments (`192.0.0.0/24`), 6to4 relay anycast (`192.88.99.0/24`), documentation/test ranges (`192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`), benchmarking (`198.18.0.0/15`), multicast (`224.0.0.0/4`), and reserved/broadcast (`240.0.0.0/4`) ranges
- IPv6 loopback (`::1`), unspecified (`::`), ULA (`fc00::/7`), link-local (`fe80::/10`)
- IPv4-mapped IPv6 addresses that resolve to any of the above (e.g. `::ffff:127.0.0.1`)
- Redirects are validated **before** they are followed — a public URL that redirects to a private address is also blocked

For direct `web_url_read` requests, DNS answers are also validated before the TCP/TLS connection is established. If a public-looking hostname resolves to any blocked private, loopback, link-local, or unspecified address, the request is rejected. The connection is pinned to the validated DNS answer so a hostname cannot pass validation and then rebind to a different address for the actual connection.

When a URL-reader proxy is configured (`URL_READER_HTTP_PROXY`, `URL_READER_HTTPS_PROXY`, `HTTP_PROXY`, or `HTTPS_PROXY`), the proxy performs DNS resolution. In that mode, this client-side DNS validation cannot inspect the final resolved IP address; proxied deployments should rely on proxy, firewall, and egress controls to restrict internal network access.

To allow private URL reads and private DNS-resolved targets (e.g. for internal deployments), set `MCP_HTTP_ALLOW_PRIVATE_URLS=true`. Do this only when internal fetching is intentional.

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

The default bind address is `127.0.0.1` (loopback only); set `MCP_HTTP_HOST=0.0.0.0` to expose the port on all interfaces.

### TLS and CA Certificates

The server auto-detects system CA bundles on Linux and macOS for outbound HTTPS connections. On Windows, set `NODE_EXTRA_CA_CERTS` to a PEM file if you need custom CAs. Custom CAs are applied to both the SearXNG connection and all `web_url_read` fetches.

### Redirect Handling

The `web_url_read` tool manually follows redirects (up to 5 hops). Each intermediate URL is validated against the private-IP blocklist before the request is made. On the direct no-proxy path, each redirect hop also goes through DNS-answer validation before connecting.

### URL Reader Size Limits

`web_url_read` enforces `URL_READ_MAX_CONTENT_LENGTH_BYTES` while streaming the response body. The HEAD `Content-Length` check remains as a cheap early rejection path, but the streaming cap is authoritative and also applies when the server omits `Content-Length`, uses chunked transfer encoding, or sends more data than it reported. The cap is measured after undici's transparent Content-Encoding decompression, which bounds the in-memory content size used for HTML-to-Markdown conversion.

## Deployment Recommendations

The published container image runs as the non-root numeric user UID 1000, so Kubernetes deployments can use `runAsNonRoot: true` without setting an additional `runAsUser`.

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
MCP_HTTP_TRUST_PROXY=1              # trust one reverse-proxy hop
MCP_HTTP_AUTH_TOKEN=<random-256bit>
MCP_HTTP_ALLOWED_ORIGINS=https://your-app.example.com
MCP_HTTP_ALLOWED_HOSTS=your-app.example.com
MCP_HTTP_ALLOW_PRIVATE_URLS=false   # default, keep this off
```

Place the server behind a TLS-terminating reverse proxy (nginx, Caddy, Traefik). Do not expose the MCP HTTP port directly to the internet.

Enable `MCP_HTTP_TRUST_PROXY` only when the server is behind a trusted reverse proxy that strips and sets `X-Forwarded-For`. Enabling it on a directly exposed server lets clients spoof their IP address to evade rate limits and forge request IPs in logs.

### Secrets in Environment Variables

SearXNG Basic Auth is supported by embedding credentials in the `SEARXNG_URL` userinfo — see the [Authentication section of CONFIGURATION.md](CONFIGURATION.md#authentication) for the exact format. This is the recommended path because each semicolon-separated instance URL can carry its own credentials. URL userinfo is stripped from outgoing fetch URLs and redacted from logs and errors.

`AUTH_PASSWORD` remains available as a legacy global fallback when a `SEARXNG_URL` entry has no userinfo. `MCP_HTTP_AUTH_TOKEN`, proxy credentials, and any credentials embedded in `SEARXNG_URL` are secrets. Avoid committing them to source control. Use secret management (Docker secrets, environment injection at runtime, or a secrets manager) in production.

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

## Container Image Security

The published Docker image (`isokoliuk/mcp-searxng`) is built from a digest-pinned `node:lts-alpine` base. Base-image updates are automated:

- **Dependabot** opens a weekly PR when the digest behind `node:lts-alpine` moves, so new releases always build on a current base.
- **A weekly rebuild workflow** compares the published image's base digest (recorded in its `org.opencontainers.image.base.digest` OCI label) against upstream. On drift, it rebuilds from the latest release tag with the patched base, re-scans with Trivy, and republishes the same version tags.

As a result, version tags (e.g. `1.3.2`) are **mutable**: pulling the same tag after an upstream security fix returns the same application code on a patched base. Pin by image digest if you require immutability, and use the `org.opencontainers.image.base.digest` label to audit which base an image was built from.

Every published image is scanned with Trivy (CRITICAL/HIGH severities, unfixed ignored) before release; results are uploaded to the repository's GitHub Security tab.

Published images are signed with [Cosign](https://docs.sigstore.dev/cosign/) using GitHub Actions keyless OIDC identity. Verify an image signature before running it:

```bash
cosign verify \
  --certificate-identity-regexp 'https://github.com/ihor-sokoliuk/mcp-searxng/.github/workflows/(docker-publish|docker-rebuild)\.yml@.*' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  docker.io/isokoliuk/mcp-searxng:latest
```
