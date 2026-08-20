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
| HTTP transport | Unauthorized access, DNS rebinding, CORS misconfiguration, resource exhaustion, or unfair shared capacity |
| Proxy credentials | Credential exposure in environment variables |
| SearXNG credentials | Credentials in `SEARXNG_URL` userinfo or legacy `AUTH_PASSWORD` fallback |
| Query forwarding | Search queries are forwarded verbatim to SearXNG |
| PDF text extraction | Untrusted PDF content is processed by a third-party parser |

## Security Features

### SearXNG Response-Body Limits

`SEARXNG_MAX_RESPONSE_BYTES` bounds the bytes this MCP client retains from each
successful SearXNG search JSON response, HTML fallback, `/config`, and
`/autocompleter` response. It defaults to 5 MiB and accepts only strict
integers from 1 through 16 MiB; an invalid value falls back to the default with
one value-free warning per MCP server. This is a per-response retained-byte
admission limit, not an aggregate or concurrency limit, and it does not change,
deploy, restart, reconfigure, or impose settings on the SearXNG service.

For non-success search responses, the client retains at most the lower of the
configured limit and 64 KiB for a credential-sanitized diagnostic preview,
preserves the HTTP status, and appends the fixed `[Response body truncated]`
marker when that preview is cut short. Non-success `/config` and
`/autocompleter` bodies are canceled rather than disclosed. Search deadlines
cover headers, body streaming, decoding, and parsing; JSON and HTML fallback
deadlines are separate and additive, as are per-instance failover attempts.
The fixed 5-second `/config` and `/autocompleter` deadlines include body
consumption. Oversize, stalled, partial, malformed, and read failures do not
populate successful caches or health state and use the existing failure,
negative-cache, or empty-array behavior.

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

### Delegated Browser Service

Setting `FLARESOLVERR_URL` or `BYPARR_URL` delegates challenge-page navigation
to a trusted browser service. FlareSolverr 3.5.0 and Byparr 2.1.0 were verified
on 2026-07-30. When both endpoints are configured, this release uses
FlareSolverr as the fixed primary and Byparr as the fallback only for busy or
transient-unavailable acquisition.
Canonical duplicate endpoints fail closed.

The verified `linux/amd64` images came from multi-architecture manifests
`ghcr.io/flaresolverr/flaresolverr:v3.5.0@sha256:139dfee1c6f89249c8d665d1333a42e8ec74ec0a86bc6bb1c8461e10d3a66a47`
and
`ghcr.io/thephaseless/byparr:2.1.0@sha256:01a46a2865d9a6db5eb8ead04ec0dd33b8fbe233e8565ae70b50d4cc0af4cfb0`.
Client cancellation stops local work promptly, but a remote browser may
continue until its configured provider timeout after the HTTP client
disconnects.

Static URL policy runs before cache lookup, and cache hits bypass network
preflight and solver acquisition. For uncached reads, `mcp-searxng` validates
the requested target and performs the HEAD size preflight before
attempting acquisition. When a solver slot is available, every uncached URL that
passes URL validation and the HEAD size preflight is disclosed to that provider.
In dual mode an allowed primary failure discloses the same URL to Byparr.
Independent concurrency limits prevent either provider from consuming the
other's slots. `mcp-searxng` accepts a solution only for
the same hostname, filters returned cookies by domain, path, secure flag, and
expiry, rejects cookie names or values outside the HTTP cookie character set or
above 4096 bytes per pair, and performs the final target fetch through the
normal URL-reader controls. Replay restarts at the originally requested URL;
the solver-returned URL is used only for same-host integrity validation.

The browser service performs its own navigation internally. `mcp-searxng`
cannot intercept or validate every redirect the browser follows while solving a
challenge. Treat that service as part of the trusted deployment boundary:

- keep it on a private network and do not publish its API port;
- use firewall or container-network egress rules to block private services,
  localhost, and cloud metadata endpoints;
- run it with the least privileges and resource limits appropriate to a browser
  workload;
- keep the solver image updated and review its own security guidance.

Transient or busy primary outcomes advance to Byparr; the final busy or
unavailable outcome uses the direct URL-reader path once. Persistent provider
4xx, hostname divergence, and solved non-2xx target status stop the chain.
Cancellation
does not trigger fallback and is propagated through acquisition, replay, body
streaming, and PDF extraction. Invalid solver configuration fails closed. The solver API
response is capped at 256 KiB for FlareSolverr and 5 MiB for Byparr. During
2.1.0 verification, Byparr returned rendered content alongside cookies.
Concurrent
acquisitions are bounded independently by the selected provider's
`*_MAX_CONCURRENT_REQUESTS` variable.

Each provider keeps its full timeout. The default dual-provider worst case is
150 seconds across preflight, both acquisitions, and one direct GET. Repeated
value-free `unavailable` warnings for the same provider should trigger
operational alerting; this feature does not retain a health score or silently
reverse provider order.

### PDF Text Extraction

PDF responses are untrusted parser input. The URL reader enters the parser only
for `application/pdf` responses whose body begins with the `%PDF-` signature.
The downloaded input and extracted UTF-8 text are each capped at the lower of
`URL_READ_MAX_CONTENT_LENGTH_BYTES` and 16 MiB. Documents above 500 pages are
rejected, OCR is not performed, and each parse has a separate 30-second worker
budget.

At most two PDF extractions run concurrently per MCP process. There is no
queue; additional concurrent reads return a retryable busy explanation. Each
worker has a 192 MiB V8 old-generation ceiling and a 4 MiB stack ceiling.
Parser evaluation, XFA, system fonts, font rendering, automatic fetching,
streaming, worker fetching, WebAssembly, and external parser resource URLs are
disabled. The worker also blocks Node fetch, HTTP(S), TCP, and TLS primitives
while loading and running the parser. Parser and worker failures return generic
explanations rather than internal error details.

These controls are defense in depth for a third-party parser. A worker thread
is not an operating-system sandbox or a separate security principal: it shares
the process identity and filesystem privileges. The 192 MiB value is a V8
old-generation ceiling, not reserved memory or a complete process-memory
limit. Run the MCP process with least privilege and external container,
filesystem, and egress controls appropriate for untrusted content.

### Hardened HTTP Mode

When `MCP_HTTP_PORT` is set, the server exposes an HTTP endpoint. By default it has no authentication. Enable hardened mode for any network-accessible deployment:

```
MCP_HTTP_HARDEN=true
MCP_HTTP_AUTH_TOKEN=<strong-random-token>
MCP_HTTP_ALLOWED_ORIGINS=https://your-app.example.com
```

Hardened mode protects the MCP protocol endpoint (`/mcp`) with:

- **Bearer token authentication** on every `/mcp` request (`Authorization: Bearer <token>`)
- **Origin allowlist** — `/mcp` requests from unlisted browser origins are rejected
- **DNS rebinding protection** — the `Host` header is validated against `MCP_HTTP_ALLOWED_HOSTS`. The default allows loopback access on the configured port (`127.0.0.1`, `localhost`, `[::1]` and their `:PORT` forms). A custom list is matched exactly against `Host`: an entry matches only when it carries the same port the client or proxy sends (e.g. `app.example.com:8443`).

With `MCP_HTTP_STATELESS=true`, bearer authorization and the hardened Host and Origin checks run before any per-request MCP server is constructed. Rate limiting also runs before construction, followed by the stateless capacity controls.

`MCP_HTTP_HARDEN=true` will fail to start if `MCP_HTTP_AUTH_TOKEN` or `MCP_HTTP_ALLOWED_ORIGINS` are missing.

### Origin validation and upgrade notice

When an `/mcp` request includes an `Origin`, the server validates it against the applicable allowlist in hardened and non-hardened modes; an absent `Origin` remains accepted for non-browser clients. In non-hardened mode, an unset `MCP_HTTP_ALLOWED_ORIGINS` defaults to the exact HTTP/HTTPS loopback origins `http://127.0.0.1`, `https://127.0.0.1`, `http://localhost`, `https://localhost`, `http://[::1]`, and `https://[::1]`, both portless and with the configured `MCP_HTTP_PORT`. A non-empty `MCP_HTTP_ALLOWED_ORIGINS` replaces those defaults. Entries are trimmed but otherwise literal; matching is exact, case-sensitive literal matching, including scheme and port. Malformed, scheme-less, path-bearing, trailing slash, or differently-cased values silently do not match and must be corrected. Hardened mode still requires an explicit allowlist and adds authentication plus Host enforcement. An invalid present `Origin` on `/mcp` receives a fixed, non-reflecting 403 before parser, authentication, rate limiting, or transport construction. `/health` is outside the MCP 403 boundary but uses the narrowed global CORS allowlist. Before upgrading, existing non-hardened browser deployments using non-loopback Origins must set `MCP_HTTP_ALLOWED_ORIGINS` or receive a fixed 403. This change addresses the Origin security requirement; legacy transport compatibility remains and is not a claim of full MCP 2026-07-28 transport compliance.

`GET /health` intentionally remains unauthenticated so container orchestrators
and load balancers can perform liveness checks. It is independently limited to
60 requests per minute and returns only `status`, `server`, `version`, and
`transport`; it does not return the SearXNG URL or server configuration. Public
version metadata permits version fingerprinting, which is the accepted trade-off
for this unauthenticated operational endpoint. Restrict the network path to the
health endpoint when your threat model does not accept that disclosure.

### Transport Security

STDIO mode (default) is the most secure deployment: the server communicates only over stdin/stdout with the parent process — no network socket is opened, no authentication is needed.

For HTTP mode, bind to `127.0.0.1` unless external access is required:

```
MCP_HTTP_HOST=127.0.0.1
```

The default bind address is `127.0.0.1` (loopback only); set `MCP_HTTP_HOST=0.0.0.0` to expose the port on all interfaces.

Optional stateless mode isolates each POST in a fresh MCP server and transport. It does not preserve cross-request sessions, subscriptions, resumability, or standalone notification streams. Responses remain confined to negotiated JSON or an SSE stream within the initiating POST; GET and DELETE on `/mcp` are rejected with HTTP 405.

Stateless mode uses global and per-client-IP in-flight caps plus a request lifetime so abandoned or expensive requests cannot occupy unbounded process resources. Saturation is rejected before server construction. These are process-local controls: horizontally scaled deployments enforce the global cap independently in each process.

The per-IP cap uses Express's resolved request IP, just like rate limiting and request diagnostics. Configure `MCP_HTTP_TRUST_PROXY` only for a known proxy topology whose edge strips and sets forwarding headers. Otherwise clients can spoof `X-Forwarded-For`, evade fair per-IP allocation, and influence logs. Application capacity limits complement, but do not replace, reverse-proxy connection limits and infrastructure-level timeouts.

Requests whose client IP cannot be resolved share one fail-closed capacity bucket. This avoids treating missing identity data as a new client on every request, at the cost of shared contention among those unusual connections.

### TLS and CA Certificates

The server auto-detects system CA bundles on Linux and macOS for outbound HTTPS connections. On Windows, set `NODE_EXTRA_CA_CERTS` to a PEM file if you need custom CAs. Custom CAs are applied to both the SearXNG connection and all `web_url_read` fetches.

### Redirect Handling

The `web_url_read` tool manually follows redirects (up to 5 hops). Each intermediate URL is validated against the private-IP blocklist before the request is made. On the direct no-proxy path, each redirect hop also goes through DNS-answer validation before connecting.

### URL Reader Size Limits

`web_url_read` enforces `URL_READ_MAX_CONTENT_LENGTH_BYTES` while streaming the
response body. The HEAD `Content-Length` check remains as a cheap early
rejection path, but the streaming cap is authoritative and also applies when
the server omits `Content-Length`, uses chunked transfer encoding, or sends
more data than it reported. The cap is measured after undici's transparent
Content-Encoding decompression, which bounds the body retained for conversion
or parsing. PDF extraction has the additional fixed limits described above.

## Deployment Recommendations

The published container image runs as the non-root numeric user UID 1000, so Kubernetes deployments can use `runAsNonRoot: true` without setting an additional `runAsUser`.

### Minimal / Local

Use the default STDIO transport. No additional configuration is needed beyond `SEARXNG_URL`.

### Internal Network (HTTP)

```
MCP_HTTP_HOST=127.0.0.1   # bind to loopback only
MCP_HTTP_PORT=3000
# Optional for serverless/process-local isolation: MCP_HTTP_STATELESS=true
```

### Public / Internet-Facing (HTTP)

```
MCP_HTTP_HARDEN=true
MCP_HTTP_HOST=127.0.0.1             # put a reverse proxy in front
MCP_HTTP_TRUST_PROXY=1              # trust one reverse-proxy hop
MCP_HTTP_AUTH_TOKEN=<random-256bit>
MCP_HTTP_ALLOWED_ORIGINS=https://your-app.example.com
MCP_HTTP_ALLOWED_HOSTS=your-app.example.com   # exact Host match; add ":port" if the proxy forwards one
MCP_HTTP_ALLOW_PRIVATE_URLS=false   # default, keep this off
```

Place the server behind a TLS-terminating reverse proxy (nginx, Caddy, Traefik). Do not expose the MCP HTTP port directly to the internet.

Enable `MCP_HTTP_TRUST_PROXY` only when the server is behind a trusted reverse proxy that strips and sets `X-Forwarded-For`. Enabling it on a directly exposed server lets clients spoof their IP address to evade rate limits and forge request IPs in logs.

### Secrets in Environment Variables

SearXNG Basic Auth is supported by embedding credentials in the `SEARXNG_URL` userinfo — see the [Authentication section of CONFIGURATION.md](CONFIGURATION.md#authentication) for the exact format. This is the recommended path because each semicolon-separated instance URL can carry its own credentials. URL userinfo is stripped from outgoing fetch URLs and redacted from logs and errors, and it is redacted from the `config://server-config` resource as well (the host is shown, credentials are not). The `/health` endpoint does not expose `SEARXNG_URL`.

Diagnostic output is sanitized before process output, MCP logging
notifications, JSON-RPC errors, or HTTP diagnostic errors are emitted.
Malformed SearXNG instance values are reported by entry number and
classification without echoing the raw value. The configuration resource and
outgoing requests also omit URL userinfo.

Environment configuration is captured when the process starts. Restart the
server after rotating or changing SearXNG Basic Auth credentials so both
requests and diagnostic redaction use the new values.

### Tool Invocation Admission

The server applies one process-wide admission boundary to MCP `tools/call`
requests from STDIO and both HTTP transport modes. This is distinct from the
HTTP request rate limiter: protocol initialization, discovery, resources,
logging, and health checks remain available even when the tool budget is
exhausted. Tool admission uses a fixed monotonic window plus a hard no-queue
in-flight ceiling. Rejection is a stable retry-with-backoff tool result and
does not expose arguments, credentials, configured limits, counters, or timing
details.

The shared process budget intentionally bounds total work rather than providing
per-client fairness. Consequently, one session may consume capacity needed by
another. Slots normally return when handlers settle; if an upstream handler
remains pending indefinitely, operators can restart the process to reclaim that
capacity.
Configure the `MCP_TOOL_*` limits for the
deployment, require client backoff, and use separate process replicas where
tenant isolation is needed. See [Tool Invocation Admission](CONFIGURATION.md#tool-invocation-admission-all-transports)
for defaults, ranges, and fixed-window boundary behavior.

Because credentials may be embedded in it, treat the whole `SEARXNG_URL` as a secret: `AUTH_PASSWORD` remains available as a legacy global fallback when a `SEARXNG_URL` entry has no userinfo, and `MCP_HTTP_AUTH_TOKEN`, proxy credentials, and any credentials embedded in `SEARXNG_URL` are secrets. Avoid committing them to source control. Use secret management (Docker secrets, environment injection at runtime, or a secrets manager) in production.

If an older release emitted SearXNG credentials into logs or client-visible
errors, upgrade before further use, rotate the affected credentials, and remove
or restrict access to captured logs and telemetry. For coordinated fixes,
publish the patched runtime and updated MCP registry metadata before making the
advisory public.

## Scope

The following are **in scope** for security reports:

- SSRF bypasses in `web_url_read` (IP parsing edge cases, redirect chain escapes, IPv6 encoding tricks)
- Authentication/authorization bypasses in HTTP transport
- DNS rebinding bypasses
- CORS misconfiguration allowing unintended cross-origin access
- Sensitive data leakage (credentials, tokens) in logs or HTTP responses
- Realistic PDF parser code-execution, data-exfiltration, or network-guard bypasses
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

### Published npm Dependency Verification

npm applies `overrides` only from the installing root project, so an override in this package cannot guarantee the dependency tree selected by another application. Before publication, the release workflow packs the actual npm artifact, installs it into an isolated clean consumer whose only direct dependency is that artifact, and verifies that every resolved `@hono/node-server` copy is at least the first patched version, `2.0.5`. The same gate requires a zero-vulnerability production audit and completes an MCP initialize and tools-list smoke test against the installed artifact. npm then publishes that exact verified tarball rather than packing the working tree again.

This guarantee describes the isolated single-dependency installation checked by the release workflow. An existing or newly created application can retain or introduce a different tree through sibling dependency constraints, its lockfile, or root overrides. Consumers should review those constraints after upgrading and run:

```bash
npm audit --omit=dev
```

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
