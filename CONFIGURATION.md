# Configuration Reference

All environment variables for `mcp-searxng`, organized by concern. All variables are optional unless marked required.

## Core

| Variable | Required | Default | Description |
|---|---|---|---|
| `SEARXNG_URL` | Yes | — | URL of your SearXNG instance, or a semicolon-separated list of interchangeable replica base URLs. Single URL behavior is unchanged. Format: `<protocol>://[username[:password]@]<hostname>[:<port>][/path]` (e.g. `http://localhost:8080`, `https://user:pass@search.example.com`, `https://searx.example.com/searxng`, or `https://user:pass@one.example.com;https://two.example.com`) |
| `SEARXNG_FANOUT` | No | `false` | Set to `true` to query all healthy configured SearXNG instances in parallel and merge results. Default failover mode tries instances in order until one returns results. |

When `SEARXNG_URL` contains multiple semicolon-separated URLs, they are treated as interchangeable replicas. Default mode fails over in order when an instance hard-fails or returns no results. A reachable `200 OK` response with an empty `results` array is considered healthy and does not trigger cooldown. Instances with 3 consecutive hard failures are skipped for 60 seconds.

With `SEARXNG_FANOUT=true`, all healthy instances are queried in parallel. Results are deduplicated by canonical URL, the copy with the highest `score` is kept, and merged results are ordered by descending score. Capability discovery and filter guidance aggregate `/config` data from all reachable configured instances; `common` categories/engines work everywhere reachable, while `available` values are best-effort. A `/config` endpoint that fails is skipped for about 60 seconds before retry, or retried immediately when `searxng_instance_info` is called with `refresh=true`. Search suggestions use the first configured instance.

For SearXNG setup, direct verification, and replica troubleshooting, see
[Operating Self-Hosted SearXNG with mcp-searxng](docs/self-hosted-searxng.md).
For MCP-process capacity planning and optional Docker limits, see the
[measured deployment profiles](docs/deployment-profiles.md).

## Search Provider

| Variable | Required | Default | Description |
|---|---|---|---|
| `SEARCH_PROVIDER` | No | `searxng` | Search provider to use: `searxng` (default, requires `SEARXNG_URL`) or `youcom` (You.com Search API). |
| `YDC_API_KEY` | No | — | You.com API key for authenticated access when `SEARCH_PROVIDER=youcom`. Without this key, uses keyless operation (100 free searches/day per IP). Get your key at [you.com/platform/api-keys](https://you.com/platform/api-keys). |

**You.com Provider Notes:**
- **Keyless operation**: When `YDC_API_KEY` is not set, uses You.com's free tier (100 searches/day per IP address)
- **Authenticated operation**: With `YDC_API_KEY` set, gets higher quotas and enhanced features per your You.com plan
- **Parameter mapping**: `categories` maps to domain filtering, `time_range` maps to freshness, `safesearch=2` enables safe search
- **Pagination**: You.com searches are not paginated; `pageno > 1` returns empty results
- **Fallback**: If You.com fails, the error is returned (no automatic fallback to SearXNG)

## Authentication

For SearXNG instances protected with HTTP Basic Auth, embed credentials in each `SEARXNG_URL` entry:

```bash
SEARXNG_URL=https://username:password@search.example.com
```

For multiple interchangeable replicas, each semicolon-separated URL can carry its own credentials. This supports mixed deployments such as one private auth-gated instance and one public instance without sending the private credentials to the public host:

```bash
SEARXNG_URL=https://alice:secret@private-search.example.com;https://public-search.example.com
```

Percent-encode special characters in usernames or passwords before placing them in the URL. For example, password `p@ss` should be written as `p%40ss`.

| Variable | Required | Default | Description |
|---|---|---|---|
| `AUTH_USERNAME` | No | — | Legacy global HTTP Basic Auth username fallback used only when a `SEARXNG_URL` entry has no userinfo |
| `AUTH_PASSWORD` | No | — | Legacy global HTTP Basic Auth password fallback used only when a `SEARXNG_URL` entry has no userinfo |

## Timeouts

| Variable | Required | Default | Description |
|---|---|---|---|
| `SEARXNG_TIMEOUT_MS` | No | `10000` | Maximum time in milliseconds to wait for a SearXNG search response. The request is aborted and a network error is returned if the server does not respond within this window. Invalid, non-positive, or out-of-range values (above `2147483647`) fall back to the default. |
| `FETCH_TIMEOUT_MS` | No | `10000` | Maximum time in milliseconds to wait for a `web_url_read` fetch. The request is aborted and an error is returned if the server does not respond within this window. |

## Tool Schema

| Variable | Required | Default | Description |
|---|---|---|---|
| `SEARXNG_LITE_TOOLS` | No | `false` | Set to `true` to register minimal tool schemas with only `query` / `url` parameters. Reduces per-call token overhead for local models with small context windows. Extra parameters (e.g. `language`, `maxLength`) passed by the caller are still accepted and forwarded. |

## Search Defaults

Operator-level defaults applied when the caller omits the corresponding per-call parameter.

| Variable | Required | Default | Description |
|---|---|---|---|
| `SEARXNG_DEFAULT_LANGUAGE` | No | `all` | Default language for all searches when `language` is not passed per call (e.g. `en`, `fr`, `de`). |
| `SEARXNG_DEFAULT_SAFESEARCH` | No | — | Default safe-search level: `0` (off), `1` (moderate), `2` (strict). Invalid values are ignored with a warning. When unset, the SearXNG instance default applies. |
| `SEARXNG_DEFAULT_RESPONSE_FORMAT` | No | `text` | After trimming whitespace, accepted values are the exact lowercase `text` or `json`. Unset or blank values use `text` silently; invalid values warn once per server instance and use `text`. If omitted, `SEARXNG_DEFAULT_RESPONSE_FORMAT` applies; if unset or invalid, `text` is used. An explicit `response_format` always takes precedence. |

Clients that explicitly send or auto-inject `response_format=text` continue to override the operator default. If an omitted call still returns text after configuring JSON, inspect the tool arguments emitted by the MCP client.

The response-format default also applies when `SEARXNG_LITE_TOOLS=true`. Lite schemas omit optional parameters, but callers that send `response_format` explicitly still override the configured default, consistent with the existing forwarding behavior for extra lite-tool arguments.

## Search Result Controls

| Variable | Required | Default | Description |
|---|---|---|---|
| `SEARXNG_MAX_RESULTS` | No | — | Operator-level maximum number of search results to return per call (1-20). Invalid values are ignored. Recommended: `10` for smaller context windows. |
| `SEARXNG_MAX_RESULT_CHARS` | No | — | Maximum characters to include in each search result snippet. Longer snippets are truncated and marked with `…`. Invalid values are ignored. Recommended: `500` for smaller context windows. |
| `SEARCH_CACHE_TTL_MS` | No | `86400000` | Search result cache TTL in milliseconds. Invalid or non-positive values fall back to the default (24 hours). |
| `SEARCH_CACHE_MAX_ENTRIES` | No | `200` | Maximum number of cached search queries. When the cache exceeds this size, the least frequently used entry is evicted, with oldest entry used as the tie-breaker. Invalid or non-positive values fall back to the default. |

Search results are cached in memory per process only; cache contents are not persisted across restarts. Cached text responses are marked with `_Cached result_`. Cached JSON responses remain parseable and include a top-level `"cached": true` field.

## Search Compatibility

Self-hosting SearXNG with JSON output enabled remains the recommended setup. The HTML fallback is best-effort for public instances that reject `format=json`; HTML theme differences may limit parsed metadata.

For the self-hosted SearXNG configuration and verification procedure, see
[Operating Self-Hosted SearXNG with mcp-searxng](docs/self-hosted-searxng.md).
For an instance you do not control, see
[Using a Public SearXNG Instance with mcp-searxng](docs/public-searxng-instances.md)
for trust, evaluation, and conservative-use guidance.

| Variable | Required | Default | Description |
|---|---|---|---|
| `SEARXNG_HTML_FALLBACK` | No | `false` | Set to `true` to retry 403/404 or non-JSON search responses as an HTML search page and parse title, URL, and snippet only. HTML fallback results are marked with `sourceFormat: "html"` in JSON output. |

## URL Reader Controls

| Variable | Required | Default | Description |
|---|---|---|---|
| `URL_READ_MAX_CHARS` | No | — | Default maximum characters returned by `web_url_read` when the caller omits `maxLength`. Explicit `maxLength` always wins. Invalid values are ignored. |
| `URL_READ_MAX_CONTENT_LENGTH_BYTES` | No | `5242880` | Maximum decompressed response-body bytes `web_url_read` will read while streaming a page. A HEAD `Content-Length` preflight may reject oversized pages before GET, but the streaming cap is authoritative. PDF input and extracted text additionally have a fixed 16 MiB ceiling. Invalid values fall back to the default. |
| `FLARESOLVERR_URL` | No | — | Base URL of a trusted FlareSolverr service, such as `http://flaresolverr:8191`. When set, `web_url_read` attempts to ask its `/v1` API for a browser session after an uncached URL passes URL validation and the HEAD size preflight. |
| `FLARESOLVERR_TIMEOUT_MS` | No | `60000` | Maximum session-acquisition time in milliseconds, from `1` through `300000`. Invalid values use the default. This is separate from `FETCH_TIMEOUT_MS`, which starts when the target is replayed. |
| `FLARESOLVERR_MAX_CONCURRENT_REQUESTS` | No | `2` | Maximum concurrent FlareSolverr acquisitions per MCP process, from `1` through `16`. In dual mode, a full primary limit advances to Byparr instead of waiting in a queue. |
| `BYPARR_URL` | No | — | Base URL of a trusted Byparr service, such as `http://byparr:8191`. It may be configured alone or with `FLARESOLVERR_URL`; dual mode always tries FlareSolverr first. |
| `BYPARR_TIMEOUT_SECONDS` | No | `60` | Maximum Byparr session-acquisition time in whole seconds, from `1` through `300`. Invalid values use the default. |
| `BYPARR_MAX_CONCURRENT_REQUESTS` | No | `2` | Maximum concurrent Byparr acquisitions per MCP process, from `1` through `16`. It is independent from the FlareSolverr counter. |
| `CACHE_TTL_MS` | No | `86400000` | URL cache TTL in milliseconds. Invalid or non-positive values fall back to the default (24 hours). |
| `CACHE_MAX_ENTRIES` | No | `500` | Maximum number of cached URLs. When the cache exceeds this size, the least frequently used entry is evicted, with oldest entry used as the tie-breaker. Invalid or non-positive values fall back to the default. |

FlareSolverr 3.5.0 and Byparr 2.1.0 were verified on 2026-07-30. Configure
either provider, both providers, or neither provider. With both endpoints,
FlareSolverr is always primary and Byparr is the secondary; ordering is not
configurable and automatic reverse failover is not performed. Canonically
identical endpoints fail startup without echoing either configured value.

The verified `linux/amd64` images came from multi-architecture manifests
`ghcr.io/flaresolverr/flaresolverr:v3.5.0@sha256:139dfee1c6f89249c8d665d1333a42e8ec74ec0a86bc6bb1c8461e10d3a66a47`
and
`ghcr.io/thephaseless/byparr:2.1.0@sha256:01a46a2865d9a6db5eb8ead04ec0dd33b8fbe233e8565ae70b50d4cc0af4cfb0`.
Client cancellation stops local work promptly, but a remote browser may
continue until its configured provider timeout after the HTTP client
disconnects. See [browser solver verification](docs/browser-solver-verification.md).

Each provider URL accepts either an absolute HTTP(S) service base URL or an
already-complete `/v1` endpoint; the suffix is normalized idempotently. Query
strings, fragments, userinfo, and other URL schemes are rejected at startup and
again during request resolution without echoing the configured value.
This is stricter than the previous per-read validation: an existing
`FLARESOLVERR_URL` containing userinfo, a query, a fragment, or an invalid
scheme now prevents startup until corrected.
`FLARESOLVERR_TIMEOUT_MS` is sent to the solver as its browser-work budget;
`BYPARR_TIMEOUT_SECONDS` is sent in seconds. The client permits up to 5
additional seconds to receive and validate either solver response.

With at least one browser-solver endpoint configured, `web_url_read` first performs its normal
target URL security and HEAD size preflight for every uncached read. It then
requests a browser session and uses only its cookies and user-agent. Byparr
2.1.0 also returns rendered content; that field is discarded after a bounded
parse.
When a solver slot is available, every uncached URL that passes URL validation
and the HEAD size preflight is disclosed to that provider. In dual mode the
same original URL can therefore be disclosed first to FlareSolverr and then to
Byparr after an allowed primary failure. The providers have independent
concurrency counters. Cache hits bypass acquisition. The actual target is
fetched by `mcp-searxng`, so
redirect validation, URL-reader proxy selection, streaming size limits, and
content-type handling remain authoritative.
Replay starts again at the originally requested URL rather than trusting a
same-host path returned by the solver.

A transient solver connection, timeout, overload, HTTP 408/429/5xx response,
malformed response, or oversized response advances to the next configured
provider. If the final provider is busy or unavailable, one uncached direct
URL-reader fetch runs. Invalid solver configuration, other HTTP 4xx responses, a
solver result for a different hostname, and a non-success target status
reported by the solver fail closed. A direct-fetch fallback result is not
cached, so repeated reads re-fetch until solver acquisition succeeds.
Solver-backed cache entries are isolated by provider and from direct-fetch
entries. Cancellation never falls back or writes a cache entry. When the
replay response is `application/pdf`, the URL reader applies its bounded PDF
text-extraction path.

There is no shared solver timeout. At defaults, the additive maximum is 150
seconds: up to 10 seconds for the initial HEAD preflight, 65 seconds for each
provider including response grace, and 10 seconds for the final direct GET.
MCP cancellation stops the chain immediately when the client propagates it.
Repeated value-free `unavailable` warnings for one provider should be monitored
as persistent degradation.

Example with the official FlareSolverr image:

```yaml
services:
  mcp-searxng:
    image: isokoliuk/mcp-searxng:latest
    stdin_open: true
    environment:
      - SEARXNG_URL=${SEARXNG_URL:?Set SEARXNG_URL in the environment}
      - FLARESOLVERR_URL=http://flaresolverr:8191
    depends_on:
      - flaresolverr

  flaresolverr:
    image: flaresolverr/flaresolverr:v3.5.0
    environment:
      - LOG_LEVEL=info
      - LOG_HTML=false
      - CAPTCHA_SOLVER=${CAPTCHA_SOLVER:-none}
      - TZ=America/Chicago
```

Equivalent Byparr configuration (use this block instead of FlareSolverr):

```yaml
services:
  mcp-searxng:
    image: isokoliuk/mcp-searxng:latest
    stdin_open: true
    environment:
      - SEARXNG_URL=${SEARXNG_URL:?Set SEARXNG_URL in the environment}
      - BYPARR_URL=http://byparr:8191
      - BYPARR_TIMEOUT_SECONDS=60
      - BYPARR_MAX_CONCURRENT_REQUESTS=2
    depends_on:
      - byparr

  byparr:
    image: ghcr.io/thephaseless/byparr:2.1.0
```

For dual-provider mode, combine both services and set both endpoint variables:

```yaml
services:
  mcp-searxng:
    image: isokoliuk/mcp-searxng:latest
    stdin_open: true
    environment:
      - SEARXNG_URL=${SEARXNG_URL:?Set SEARXNG_URL in the environment}
      - FLARESOLVERR_URL=http://flaresolverr:8191
      - BYPARR_URL=http://byparr:8191
    depends_on:
      - flaresolverr
      - byparr

  flaresolverr:
    image: flaresolverr/flaresolverr:v3.5.0
    environment:
      - LOG_LEVEL=info
      - LOG_HTML=false
      - CAPTCHA_SOLVER=${CAPTCHA_SOLVER:-none}

  byparr:
    image: ghcr.io/thephaseless/byparr:2.1.0
```

The solver is an operator-trusted browser service. Keep it on a private
container network, do not expose port 8191 publicly, and restrict its egress
from private services and cloud metadata endpoints. See
[SECURITY.md](SECURITY.md#delegated-browser-service) for the trust boundary.

## User-Agent

| Variable | Required | Default | Description |
|---|---|---|---|
| `USER_AGENT` | No | — | Global default User-Agent header for outgoing requests (e.g. `MyBot/1.0`) |
| `SEARCH_USER_AGENT` | No | `USER_AGENT` | User-Agent for SearXNG instance requests: `searxng_web_search`, `/config` capability discovery, and search suggestions |
| `URL_READER_USER_AGENT` | No | `USER_AGENT` | User-Agent for `web_url_read` only |

`SEARCH_USER_AGENT` and `URL_READER_USER_AGENT` are per-group overrides. When unset, both fall back to `USER_AGENT`. If neither the group override nor `USER_AGENT` is set, no User-Agent header is added by `mcp-searxng`.

When a browser solver returns a solved session, its browser User-Agent replaces
`URL_READER_USER_AGENT` / `USER_AGENT` on the replay fetch because the returned
cookies are tied to that browser identity. The configured URL-reader User-Agent
still applies to the pre-solve HEAD size check and to direct or fallback reads.

## Proxy

Interface-specific proxies take priority over global proxies for their respective tools.

| Variable | Required | Default | Description |
|---|---|---|---|
| `HTTP_PROXY` / `HTTPS_PROXY` | No | — | Global proxy for all traffic. Format: `http://[user:pass@]host:port` |
| `SEARCH_HTTP_PROXY` / `SEARCH_HTTPS_PROXY` | No | — | Proxy for all SearXNG-bound traffic: search, suggestions, and capability discovery |
| `URL_READER_HTTP_PROXY` / `URL_READER_HTTPS_PROXY` | No | — | Proxy for `web_url_read` only |
| `NO_PROXY` | No | — | Comma-separated bypass list (e.g. `localhost,.internal,example.com`) |

The solver API request uses only the global `HTTP_PROXY` / `HTTPS_PROXY` and
`NO_PROXY` settings because the selected endpoint identifies an operator-trusted
service. The target replay continues to use the URL-reader-specific proxy
settings first.

## TLS / Corporate CA

Proxy variables route traffic through a proxy. Corporate TLS inspection is a separate trust problem: the proxy re-signs upstream certificates, so Node.js must trust the proxy's root CA.

On Linux and macOS, `mcp-searxng` auto-detects the first readable system CA bundle from these paths:

- `/etc/ssl/certs/ca-certificates.crt` — Debian/Ubuntu/WSL2
- `/etc/pki/tls/certs/ca-bundle.crt` — RHEL/CentOS/Fedora
- `/etc/ssl/ca-bundle.pem` — OpenSUSE
- `/etc/ssl/cert.pem` — Alpine, macOS

If your deployment needs an additional corporate CA, set the standard Node.js `NODE_EXTRA_CA_CERTS` environment variable to a PEM file. This is a Node.js TLS setting, not an `mcp-searxng` configuration variable.

Windows has no universal CA bundle file path, so system CA auto-detection is skipped. If you are behind a TLS-inspecting corporate proxy (for example Zscaler, Netskope, Palo Alto, or Blue Coat) and see errors such as `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` or `self signed certificate in certificate chain`, export the proxy root CA to PEM and point `NODE_EXTRA_CA_CERTS` at it.

```powershell
# Export from Windows cert store (adjust the subject match to your proxy CA):
$cert = Get-ChildItem Cert:\LocalMachine\Root | Where-Object { $_.Subject -match "YourCorp" } | Select-Object -First 1
[System.IO.File]::WriteAllBytes("$env:USERPROFILE\corp-ca.cer", $cert.RawData)
certutil -encode "$env:USERPROFILE\corp-ca.cer" "$env:USERPROFILE\corp-ca.pem"
```

Example MCP client environment block:

```json
{
  "env": {
    "SEARXNG_URL": "https://searxng.example.com",
    "NODE_EXTRA_CA_CERTS": "C:\\Users\\you\\corp-ca.pem"
  }
}
```

Never set `NODE_TLS_REJECT_UNAUTHORIZED=0`. It disables all TLS certificate validation for the Node.js process and makes HTTPS connections vulnerable to interception.

## HTTP Transport

By default the server communicates over STDIO. Set `MCP_HTTP_PORT` to enable HTTP mode instead.

| Variable | Required | Default | Description |
|---|---|---|---|
| `MCP_HTTP_PORT` | No | — | Port number to enable HTTP transport (e.g. `3000`) |
| `MCP_HTTP_HOST` | No | `127.0.0.1` | Interface address to bind to. Defaults to localhost-only for security. Set `0.0.0.0` for all interfaces (required for Docker and remote deployments), or a specific IP. Works in pair with `MCP_HTTP_PORT` only. **Breaking change from v1.2.1:** previous default was `0.0.0.0`. |
| `MCP_HTTP_TRUST_PROXY` | No | `false` | Express `trust proxy` setting for deployments behind a trusted reverse proxy. Use `true`, a trusted hop count such as `1`, or a proxy subnet/preset such as `loopback` or `10.0.0.0/8`. Unset, `false`, or `0` disables it (the secure default). |
| `MCP_HTTP_STATELESS` | No | `false` | Set to the exact value `true` to create an isolated MCP server and transport for every `POST /mcp`. `false`, blank, or unset disables it; any other nonblank value warns and uses `false`. Intended for deployments that cannot preserve process-local sessions. |
| `MCP_HTTP_STATELESS_MAX_IN_FLIGHT` | No | `16` (range `1`-`256`) | Global maximum number of admitted stateless POST requests in flight. Invalid values use the default. |
| `MCP_HTTP_STATELESS_MAX_IN_FLIGHT_PER_IP` | No | `8` (range `1`-global cap) | Per-client-IP in-flight maximum. Values above the normalized global cap are reduced to that cap. |
| `MCP_HTTP_STATELESS_REQUEST_TIMEOUT_MS` | No | `900000` (range `1000`-`2147483647`) | Maximum lifetime of an admitted stateless POST, including server construction, MCP handling, and an active response stream. |

**HTTP endpoints (when HTTP mode is active):**
- Stateful default: `POST/GET/DELETE /mcp` — session-based MCP protocol
- With `MCP_HTTP_STATELESS=true`: `POST /mcp` only; GET and DELETE return HTTP 405 with `Allow: POST`
- `GET /health` — health check

HTTP sessions are stored in memory per process. A stale or unknown `mcp-session-id` on a non-initialize `POST /mcp` receives HTTP 404 with JSON-RPC error code `-32001` and message `"Session not found"`. Clients should recover by running `initialize` again; initialize requests are accepted even when they still carry a stale session header.

In stateless mode, every POST creates a fresh MCP server and transport, ignores incoming `mcp-session-id` headers, and never emits a response session ID. A POST can return negotiated JSON or an SSE stream within that same POST. Cross-request sessions, resumable streams, standalone GET notification streams, and DELETE-based session termination are unavailable. This mode does not require an SDK 2.0 upgrade; it uses the stateless transport contract provided by the currently supported SDK.

## Rate Limiting (HTTP mode)

Rate limiting is always active in HTTP mode to prevent resource exhaustion. Before the MCP handler runs, each request is counted by resolved client IP against exactly one limit. In stateful mode, POST requests with a currently live session use the session limit, other POST requests use the initialization limit, and GET/DELETE requests always use the session limit. In stateless mode, only a single parsed request object recognized by the SDK as `initialize` uses the initialization limit; all other POST bodies, including notifications and batches, use the session limit, and GET/DELETE still use the session limit. Malformed or oversized JSON is rejected by parsing before rate limiting or MCP server construction.

Each `MCP_RATE_*` value must be a positive decimal safe integer after JavaScript whitespace trimming. A leading `+` and leading zeros are accepted; fractions, suffixes, exponents, hexadecimal forms, non-positive values, and integers above `Number.MAX_SAFE_INTEGER` are rejected. An invalid value uses the documented default and emits one startup warning per variable without copying the raw value into diagnostics. Blank or unset variables use the default silently.

Before this correction, spellings such as `20requests`, `12.5`, or `1e3` could be accepted as numeric prefixes. They now fall back to the documented default, which may be looser or stricter than the value an older process effectively used. Check startup warnings and correct the environment value rather than relying on the fallback.

| Variable | Required | Default | Description |
|---|---|---|---|
| `MCP_RATE_WINDOW_MS` | No | `60000` | Sliding window duration in milliseconds for all rate limits |
| `MCP_RATE_INIT_MAX` | No | `20` | Max POST `/mcp` requests per window when `mcp-session-id` is missing or does not identify a currently live session. Guards initialization, invalid, unknown-session, and stale-session flooding. |
| `MCP_RATE_SESSION_MAX` | No | `300` | Max POST `/mcp` requests for currently live sessions and all GET/DELETE `/mcp` requests per window, including GET/DELETE requests with missing or invalid session IDs. Intentionally generous for AI agents. |

Requests exceeding a limit receive HTTP 429 with a JSON-RPC error body (`code: -32029`). `/health` has a fixed limit of 60 requests per minute. Standard `RateLimit-*` headers are included on all responses.

After a stateless request consumes its rate-limit token and passes authorization plus hardened Host/Origin checks, it must also acquire the per-IP and global in-flight capacity slots. Per-IP capacity is checked first. Saturation returns HTTP 503, `Retry-After: 1`, and JSON-RPC code `-32000` with message `Server busy`; these attempts still consume their selected rate-limit token. A request that exceeds its lifetime before response headers receives HTTP 504 and JSON-RPC code `-32000` with message `Stateless request timed out`. If an SSE response has already started, the connection is closed instead because its status can no longer be changed. Resource cleanup is bounded and capacity is reclaimed after completion, disconnect, failure, or timeout.

The in-memory store is per-process; for horizontally scaled deployments replace it with a shared Redis store via `express-rate-limit`'s `store` option.

When HTTP mode runs behind a trusted reverse proxy, set `MCP_HTTP_TRUST_PROXY` so Express can resolve the client IP from proxy headers before rate-limit keys and request logs are computed. For a single trusted proxy hop, use `MCP_HTTP_TRUST_PROXY=1`. Leave it unset for direct exposure; enabling it without a trusted proxy lets clients spoof `X-Forwarded-For`. This setting is distinct from outbound `HTTP_PROXY` / `HTTPS_PROXY`, which control this server's requests to SearXNG or URLs.

Requests whose client IP cannot be resolved share one fail-closed capacity bucket. This prevents missing identity data from bypassing the per-IP cap, but such requests can receive HTTP 503 when another unresolved-IP request occupies that bucket.

## Hardened HTTP Mode

Opt-in security layer for when you expose the HTTP transport on a network. Default HTTP behavior is unchanged — hardening must be explicitly enabled with `MCP_HTTP_HARDEN=true`.

| Variable | Required | Default | Description |
|---|---|---|---|
| `MCP_HTTP_HARDEN` | No | `false` | Set to `true` to enable all hardening features |
| `MCP_HTTP_AUTH_TOKEN` | No | — | Required bearer token for all HTTP requests in hardened mode |
| `MCP_HTTP_ALLOWED_ORIGINS` | No | — | Comma-separated CORS origin allowlist (e.g. `https://app.example.com`) |
| `MCP_HTTP_ALLOWED_HOSTS` | No | `127.0.0.1`, `localhost`, `[::1]` (+ their `:PORT` forms) | Comma-separated DNS-rebinding allowlist. Entries are matched **exactly** against the request `Host` header, **including the port** (e.g. `app.example.com:8443`). Setting this replaces the default entirely. |
| `MCP_HTTP_ALLOW_PRIVATE_URLS` | No | `false` | Allow `web_url_read` to fetch internal/private URLs, including hostnames that DNS-resolve to private/internal addresses. Private URL reads are blocked by default in all modes. |
| `MCP_HTTP_EXPOSE_FULL_CONFIG` | No | `false` | In hardened mode, include configured `SEARXNG_URL` value(s), with URL credentials redacted, in the `config://server-config` MCP resource when this flag is `true`; when `false`, report only whether a URL is configured. Non-hardened mode always includes the redacted URL value(s). No effect on `/health`. |

`MCP_HTTP_ALLOWED_HOSTS` is compared against the raw `Host` header, which includes the port. The default already covers loopback access on the configured `MCP_HTTP_PORT` (`127.0.0.1:PORT`, `localhost:PORT`, `[::1]:PORT`) plus the bare hostnames, which match a portless `Host` — a client or reverse proxy that omits the port (as on ports 80/443). When you set it explicitly, list the exact `Host` the client (or your reverse proxy) sends — e.g. `app.example.com` if the proxy forwards `Host: app.example.com` on 443, or `app.example.com:8443` if it forwards a port.

## URL Reader Security

`web_url_read` blocks private/internal URLs by default in all transport modes. This includes localhost, loopback addresses, private IPv4 ranges, link-local addresses, `0.0.0.0/8`, CGNAT (`100.64.0.0/10`), IANA special-purpose IPv4 ranges, IPv6 loopback/ULA/link-local addresses, and IPv4-mapped IPv6 private addresses.

Redirects are also checked before they are followed. A public URL that redirects to a private/internal URL is blocked.

For direct URL-reader requests without a proxy, DNS answers are validated before connecting. A public-looking hostname that resolves to a private/internal address is blocked, and the connection is pinned to the validated DNS answer to prevent DNS rebinding between validation and connection.

When a URL-reader proxy is configured (`URL_READER_HTTP_PROXY`, `URL_READER_HTTPS_PROXY`, `HTTP_PROXY`, or `HTTPS_PROXY`), the proxy performs DNS resolution. Client-side DNS-answer validation cannot inspect proxied resolutions, so proxied deployments should rely on proxy, firewall, and egress controls.

`URL_READ_MAX_CONTENT_LENGTH_BYTES` is enforced while streaming the response
body, including chunked responses and responses whose GET body is larger than
the HEAD `Content-Length` value. The limit is measured after transparent
response decompression.

For `application/pdf`, both the downloaded input and extracted UTF-8 text are
limited to the lower of this value and 16 MiB; extraction is limited to
500 pages and does not perform OCR. A response declared as PDF must begin with the
`%PDF-` signature or it returns a type-mismatch explanation without entering
the parser.

At most two PDF extractions run concurrently per MCP process. There is no
queue; additional concurrent reads return
`PDF text extraction is busy; try again later.` and may be retried. The
two-worker limit is fixed and is not configurable. Each worker has a 192 MiB
V8 old-generation ceiling and a 4 MiB stack ceiling. These are engine limits
rather than reserved memory, a complete process-memory limit, or an
operating-system sandbox.

PDF parsing starts only after the response body is complete and has its own
30-second worker budget. On the direct path, the HEAD checks and response body
share the configured `FETCH_TIMEOUT_MS` network budget, after which parsing can
take up to 30 additional seconds. With a browser solver enabled, add the initial
HEAD preflight (up to 3 seconds), solver acquisition (the selected provider
timeout plus up to 5 response-transfer seconds), and then the same replay-fetch
and parser budgets.

Set `MCP_HTTP_ALLOW_PRIVATE_URLS=true` only when internal URL reads are intentional for your deployment. This also allows hostnames that DNS-resolve to private/internal addresses.


## Combined Example (Representative Options)

This combined MCP client configuration shows the supported option groups in one place. Remove settings you do not need. Some options have dependencies: `MCP_HTTP_HARDEN=true`, `MCP_HTTP_AUTH_TOKEN`, and `MCP_HTTP_ALLOWED_ORIGINS` must be configured together; `MCP_HTTP_ALLOWED_HOSTS` and `MCP_HTTP_TRUST_PROXY` depend on the exact network and proxy topology. The representative `MCP_HTTP_TRUST_PROXY=1` value assumes exactly one trusted proxy hop. Without that trusted proxy boundary, clients can spoof `X-Forwarded-For` and influence IP-based rate limiting and logs.

```json
{
  "mcpServers": {
    "searxng": {
      "command": "npx",
      "args": ["-y", "mcp-searxng"],
      "env": {
        "SEARXNG_URL": "https://searxng.example.com",
        "AUTH_USERNAME": "legacy-fallback-user",
        "AUTH_PASSWORD": "legacy-fallback-password",
        "SEARXNG_FANOUT": "false",
        "SEARXNG_TIMEOUT_MS": "10000",
        "FETCH_TIMEOUT_MS": "10000",
        "SEARXNG_LITE_TOOLS": "false",
        "SEARXNG_DEFAULT_LANGUAGE": "en",
        "SEARXNG_DEFAULT_SAFESEARCH": "0",
        "SEARXNG_DEFAULT_RESPONSE_FORMAT": "text",
        "SEARXNG_MAX_RESULTS": "10",
        "SEARXNG_MAX_RESULT_CHARS": "500",
        "SEARCH_CACHE_TTL_MS": "86400000",
        "SEARCH_CACHE_MAX_ENTRIES": "200",
        "SEARXNG_HTML_FALLBACK": "false",
        "URL_READ_MAX_CHARS": "2000",
        "URL_READ_MAX_CONTENT_LENGTH_BYTES": "5242880",
        "FLARESOLVERR_URL": "http://flaresolverr:8191",
        "FLARESOLVERR_TIMEOUT_MS": "60000",
        "FLARESOLVERR_MAX_CONCURRENT_REQUESTS": "2",
        "CACHE_TTL_MS": "86400000",
        "CACHE_MAX_ENTRIES": "500",
        "USER_AGENT": "MyBot/1.0",
        "SEARCH_USER_AGENT": "MySearchBot/1.0",
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
        "MCP_HTTP_TRUST_PROXY": "1",
        "MCP_HTTP_STATELESS": "false",
        "MCP_HTTP_STATELESS_MAX_IN_FLIGHT": "16",
        "MCP_HTTP_STATELESS_MAX_IN_FLIGHT_PER_IP": "8",
        "MCP_HTTP_STATELESS_REQUEST_TIMEOUT_MS": "900000",
        "MCP_RATE_WINDOW_MS": "60000",
        "MCP_RATE_INIT_MAX": "20",
        "MCP_RATE_SESSION_MAX": "300",
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
