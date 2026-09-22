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
| `SEARXNG_TIMEOUT_MS` | No | `10000` | Maximum time in milliseconds for each SearXNG search attempt, covering response headers, body streaming, decoding, and parsing. The request is aborted and a network error is returned if the server does not complete within this window. Invalid, non-positive, or out-of-range values (above `2147483647`) fall back to the default. |
| `FETCH_TIMEOUT_MS` | No | `10000` | Maximum time in milliseconds to wait for a `web_url_read` fetch. The request is aborted and an error is returned if the server does not respond within this window. |
| `SEARXNG_MAX_RESPONSE_BYTES` | No | `5242880` | Maximum retained bytes read from each SearXNG response: successful search JSON, HTML fallback, `/config`, and `/autocompleter`. It is a per-response admission limit, not an aggregate or concurrency cap. |

`SEARXNG_MAX_RESPONSE_BYTES` accepts only a strict integer after surrounding JavaScript whitespace is trimmed. A leading `+` and leading zeros are accepted; `-0`, other non-positive values, fractions, exponents, suffixes, unsafe integers, and values outside the inclusive `1` through `16777216` range are invalid. Unset or blank uses `5242880` silently. An invalid value uses that default and emits one value-free warning per MCP server.

Search JSON and HTML fallback each receive their own full `SEARXNG_TIMEOUT_MS` deadline, so the fallback deadline is separate and additive; replica failover remains per instance and additive as well. `/config` and `/autocompleter` retain their fixed 5-second deadlines through body consumption. Oversized, stalled, partial, malformed, or read-failed responses do not populate successful caches or health state and follow the existing failure, negative-cache, or empty-array path.

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
| `SEARXNG_MAX_RESULT_CHARS` | No | — | Maximum characters to include in each search result snippet in both compact and full text/JSON responses, including full JSON for existing users who already set this variable. Longer snippets are truncated and marked with `…`; titles, URLs, and other metadata are never truncated. Compact text normalizes line separators before applying the cap, while JSON applies the cap to the original string value. Invalid values are ignored. Recommended: `500` for smaller context windows. |
| `SEARCH_CACHE_TTL_MS` | No | `86400000` | Search result cache TTL in milliseconds. Invalid or non-positive values fall back to the default (24 hours). |
| `SEARCH_CACHE_MAX_ENTRIES` | No | `200` | Maximum number of cached search queries. When the cache exceeds this size, the least frequently used entry is evicted, with oldest entry used as the tie-breaker. Invalid or non-positive values fall back to the default. |

Search results are cached in memory per process only; cache contents are not persisted across restarts. With `result_detail="full"`, cached text responses are marked with `_Cached result_` and cached JSON includes a top-level `"cached": true` field. Compact responses omit both markers and are returned unchanged on cache hits; absence of a marker does not prove a fresh upstream request.

## Search Compatibility

Self-hosting SearXNG with JSON output enabled remains the recommended setup. The HTML fallback is best-effort for public instances that reject `format=json`; HTML theme differences may limit parsed metadata.

For the self-hosted SearXNG configuration and verification procedure, see
[Operating Self-Hosted SearXNG with mcp-searxng](docs/self-hosted-searxng.md).
For an instance you do not control, see
[Using a Public SearXNG Instance with mcp-searxng](docs/public-searxng-instances.md)
for trust, evaluation, and conservative-use guidance.

| Variable | Required | Default | Description |
|---|---|---|---|
| `SEARXNG_HTML_FALLBACK` | No | `false` | Set to `true` to retry 403/404 or non-JSON search responses as an HTML search page and parse title, URL, and snippet only. Full JSON fallback results include `sourceFormat: "html"`; compact output omits fallback metadata. |

## URL Reader Controls

| Variable | Required | Default | Description |
|---|---|---|---|
| `URL_READ_MAX_CHARS` | No | — | Default maximum characters returned by `web_url_read` when the caller omits `maxLength`. Explicit `maxLength` always wins. Invalid values are ignored. |
| `URL_READ_MAX_CONTENT_LENGTH_BYTES` | No | `5242880` | Maximum decompressed response-body bytes `web_url_read` will read while streaming a page. A HEAD `Content-Length` preflight may reject oversized pages before GET, but the streaming cap is authoritative. PDF input and extracted text additionally have a fixed 16 MiB ceiling. Invalid values fall back to the default. |
| `FLARESOLVERR_URL` | No | — | Base URL of a trusted FlareSolverr service, such as `http://flaresolverr:8191`. When set, `web_url_read` attempts to ask its `/v1` API for a browser session after an uncached URL passes URL validation and the HEAD size preflight. |
| `FLARESOLVERR_TIMEOUT_MS` | No | `60000` | Maximum session-acquisition time in milliseconds, from `1` through `300000`. Invalid values use the default. This is separate from `FETCH_TIMEOUT_MS`, which starts when the target is replayed. |
| `FLARESOLVERR_MAX_CONCURRENT_REQUESTS` | No | `2` | Maximum concurrent FlareSolverr acquisitions per MCP process, from `1` through `16`. A full limit waits at most 1 second (or the shorter provider timeout), with at most four queued callers per configured slot. |
| `BYPARR_URL` | No | — | Base URL of a trusted Byparr service, such as `http://byparr:8191`. It may be configured alone or with `FLARESOLVERR_URL`; dual mode always tries FlareSolverr first. |
| `BYPARR_TIMEOUT_SECONDS` | No | `60` | Maximum Byparr session-acquisition time in whole seconds, from `1` through `300`. Invalid values use the default. |
| `BYPARR_MAX_CONCURRENT_REQUESTS` | No | `2` | Maximum concurrent Byparr acquisitions per MCP process, from `1` through `16`. It is independent from the FlareSolverr counter. |
| `CACHE_TTL_MS` | No | `86400000` | URL cache TTL in milliseconds. Invalid or non-positive values fall back to the default (24 hours). |
| `CACHE_MAX_ENTRIES` | No | `500` | Maximum number of cached URLs. When the cache exceeds this size, the least frequently used entry is evicted, with oldest entry used as the tie-breaker. Invalid or non-positive values fall back to the default. |

FlareSolverr 3.5.2 and Byparr 3.0.4 were verified on 2026-09-18. Configure
either provider, both providers, or neither provider. With both endpoints,
FlareSolverr is always primary and Byparr is the secondary; ordering is not
configurable and automatic reverse failover is not performed. Canonically
identical endpoints fail startup without echoing either configured value.

The verified `linux/amd64` images came from multi-architecture manifests
`ghcr.io/flaresolverr/flaresolverr:v3.5.2@sha256:c80ae007ce2ccdcd217a12426e4f039ef763ff90738c808d38810c3e59323767`
and
`ghcr.io/thephaseless/byparr:3.0.4@sha256:874f719518f617d03a60e03411fc5d090647e1a877041e81f8dc965927c7deb6`.
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
requests a browser-rendered response (`returnOnlyCookies: false`). Usable HTML
is consumed directly. Byparr responses explicitly declaring `application/pdf`
are decoded from strict base64, checked for the PDF signature, and processed by
the isolated PDF extractor. FlareSolverr PDF viewer shells and ambiguous bodies
use guarded cookie/User-Agent replay from the original requested URL. Replay
skips additional HEAD requests; GET redirects and streaming byte limits remain
authoritative. The original HEAD preflight remains in place.

Rendered content requires a fresh successful DNS-policy check on the MCP host,
even when target traffic uses a proxy. Names resolvable only by the proxy or
browser service cannot use this path: local DNS failure stops the read without
replay or provider failover. Configure working local DNS for those targets.

Provider envelope limits derive from the configured decoded-content limit,
allowing up to sixfold JSON escaping or PDF base64 overhead plus 256 KiB of
metadata, within a fixed 32 MiB ceiling.
Budget memory for encoded and decoded copies: at the maximum 16 acquisitions
per provider, 32 simultaneous default-sized envelopes can approach 1 GiB before
JSON parsing and conversion overhead. The default two slots per provider allow
up to roughly 121 MiB of envelope bytes across both providers. Lower concurrency
and content limits on memory-constrained hosts.
Rendered HTML has a 5 MiB ceiling and PDF input a 16 MiB ceiling; the configured
`URL_READ_MAX_CONTENT_LENGTH_BYTES` applies when lower. Malformed PDF bytes,
size violations, credential-bearing content, and solution integrity errors
fail closed. Only successful converted content enters the provider-specific
cache; pagination is applied afterward. Cache hits bypass acquisition.

The same original URL can be disclosed first to FlareSolverr and then to Byparr.
Each provider is attempted at most once. Transient acquisition failure permits
failover, including a solver-service retry delay (that service is not retried). A replay timeout/transient connection failure,
or target HTTP 403, 408, 500, 502, 503, or 504 also permits the next provider.
Target 429, target `Retry-After`, other persistent client errors,
cancellation, and integrity failures stop the chain. A final solved-read
failure is surfaced without another direct fetch. If all acquisitions are
unavailable, one uncached direct fetch remains available; saturation instead
returns a stable busy error after bounded waiting. Wait queues are independent
per provider and bounded at four callers per configured slot.

At defaults, stage budgets total up to 155 seconds before PDF parsing: a
3-second HEAD preflight, two 1-second slot waits, two 65-second acquisitions
including response grace, and two 10-second replay attempts. Direct rendered
content skips replay. PDF parsing can add up to 30 seconds. These are
cancellation budgets, not a precise wall-clock completion guarantee. Client
cancellation stops local acquisition, waiting, replay, and extraction.
Diagnostics contain only provider, stage, and outcome categories. Optional
persistent browser sessions and per-call provider selection are not enabled.

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

Use absolute HTTP or HTTPS proxy URLs and percent-encode special characters in
the username and password. Proxy credentials are captured at startup for
redaction in diagnostic messages; malformed proxy settings are omitted from
errors. Redaction does not rewrite proxy settings or authentication headers.
Restart after changing environment configuration.

### Credential protection in responses

SearXNG URL userinfo, the legacy `AUTH_*` credentials, and configured proxy
credentials are captured once at startup. Passwords, username-only tokens,
credential pairs, Basic tokens, common percent encodings and JSON escaping
are protected in diagnostics and returned content. Ordinary usernames with a
separate password are not globally suppressed. This does not detect arbitrary
obfuscation or secrets unknown to the server.

Tool content containing a configured credential is withheld with a fixed error,
even when the match is coincidental or the password is short. Complete content
is checked before truncation and pagination; cache hits receive the same
protection. JSON is never rewritten into a malformed result, and credential-free
content retains its existing size limits and format. Operational authentication,
routing, filtering and cache identities are unchanged. URL display copies omit
query/fragment and credentials, and conceal ambiguous settings. Invalid JSON
errors omit upstream response previews; instance discovery errors retain the
HTTP status code without reflecting upstream reason phrases.

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

By default the server communicates over STDIO. Set `MCP_HTTP_PORT` to enable HTTP mode instead. The SDK v2 server accepts modern MCP requests and retains legacy compatibility; modern HTTP clients should send the negotiated `MCP-Protocol-Version` header.

Both transports support modern `2026-07-28` plus legacy `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`, and `2024-10-07`. Modern HTTP requests are sessionless POSTs; legacy HTTP requests retain the stateful default or the configured legacy stateless mode.

Modern HTTP requests always use an isolated per-request server and are bounded by `MCP_HTTP_STATELESS_MAX_IN_FLIGHT`, `MCP_HTTP_STATELESS_MAX_IN_FLIGHT_PER_IP`, and `MCP_HTTP_STATELESS_REQUEST_TIMEOUT_MS`, even when `MCP_HTTP_STATELESS` is false. Setting `MCP_HTTP_STATELESS=true` extends that per-request serving model and the shared capacity controls to retained legacy POST requests.

The published server SDK `2.0.0` has a temporary compatibility guard for a 2026-07-28 request that omits that header: it returns the standard HTTP 400 HeaderMismatch response. The guard will be removed only after upgrading to a stable SDK containing upstream PR 2594 and proving that the SDK itself returns the same response.

| Variable | Required | Default | Description |
|---|---|---|---|
| `MCP_HTTP_PORT` | No | — | Port number to enable HTTP transport (e.g. `3000`) |
| `MCP_HTTP_HOST` | No | `127.0.0.1` | Interface address to bind to. Defaults to localhost-only for security. Set `0.0.0.0` for all interfaces (required for Docker and remote deployments), or a specific IP. Works in pair with `MCP_HTTP_PORT` only. **Breaking change from v1.2.1:** previous default was `0.0.0.0`. |
| `MCP_HTTP_TRUST_PROXY` | No | `false` | Express `trust proxy` setting for deployments behind a trusted reverse proxy. Use `true`, a trusted hop count such as `1`, or a proxy subnet/preset such as `loopback` or `10.0.0.0/8`. Unset, `false`, or `0` disables it (the secure default). |
| `MCP_HTTP_STATELESS` | No | `false` | Set to the exact value `true` to create an isolated MCP server and transport for every retained legacy `POST /mcp`; modern POSTs are always isolated. `false`, blank, or unset retains legacy stateful mode; any other nonblank value warns and uses `false`. Intended for deployments that cannot preserve process-local legacy sessions. |
| `MCP_HTTP_MAX_SESSIONS` | No | `1000` (range `1`-`10000`) | Maximum retained plus initializing legacy stateful sessions per process. At capacity, new initialization consumes its rate-limit token and returns HTTP 503 `Server busy` with `Retry-After: 1`, without constructing a server or evicting a session. Existing sessions and DELETE remain available. Blank values use the default; invalid integers warn without echoing the value and use the default. Modern HTTP, legacy stateless HTTP, and STDIO are unaffected. |
| `MCP_HTTP_INITIALIZE_TIMEOUT_MS` | No | `30000` (range `1000`-`2147483647`) | Monotonic deadline for admitted legacy stateful initialization, from capacity reservation through delivery of the initialize response. A fulfilled SDK send cancels the deadline for SSE, even if the stream remains open; non-SSE delivery completes at response finish. Expiry returns HTTP 504 `Initialization timed out` with the scalar request ID before headers, or destroys an already-started response. Partial resources and session capacity are released, and exposed session IDs become invalid. Zero and invalid values warn without echoing the value and use the default; blank values silently use the default. This does not limit established-session requests or GET streams. |
| `MCP_HTTP_STATELESS_MAX_IN_FLIGHT` | No | `16` (range `1`-`256`) | Global maximum number of admitted modern or legacy-stateless POST requests in flight. Invalid values use the default. |
| `MCP_HTTP_STATELESS_MAX_IN_FLIGHT_PER_IP` | No | `8` (range `1`-global cap) | Per-client-IP in-flight maximum for modern or legacy-stateless POSTs. Values above the normalized global cap are reduced to that cap. |
| `MCP_HTTP_STATELESS_REQUEST_TIMEOUT_MS` | No | `900000` (range `1000`-`2147483647`) | Maximum lifetime of an admitted modern or legacy-stateless POST, including server construction, MCP handling, and an active response stream. |

**HTTP endpoints (when HTTP mode is active):**
- Modern: `POST /mcp` — sessionless MCP protocol
- Legacy stateful default: `POST/GET/DELETE /mcp` — session-based MCP protocol
- With `MCP_HTTP_STATELESS=true`: `POST /mcp` only; GET and DELETE return HTTP 405 with `Allow: POST`
- `GET /health` — HTTP reachability check; returns fixed status, server, version and transport metadata without contacting SearXNG. A successful response does not verify tool calls or search readiness.

HTTP sessions are stored in memory per process. Missing or blank required session IDs on stateful POST/GET/DELETE receive JSON HTTP 400. Unknown or terminated IDs receive JSON HTTP 404 with error code `-32001` and message `"Session not found"`; initialize requests are accepted even when they still carry a stale session header and mint a new secure session ID. Clients should send `DELETE /mcp` when finished: the first valid DELETE closes the session and returns an empty HTTP 204, while a repeated DELETE returns 404. After any session 404, recover by running `initialize` again.

For stateful requests after initialization, the `MCP-Protocol-Version` header may be omitted (the negotiated version is used) or set to a supported version. Unsupported values receive HTTP 400 from the pinned SDK. Modern HTTP requests remain sessionless POSTs, and STDIO remains the default transport.

In stateless mode, every POST creates a fresh MCP server and transport, ignores incoming `mcp-session-id` headers, and never emits a response session ID. A POST can return negotiated JSON or an SSE stream within that same POST. Cross-request sessions, resumable streams, standalone GET notification streams, and DELETE-based session termination are unavailable. Modern requests use the SDK v2 request handler; retained legacy requests use the Node transport.

## Rate Limiting (HTTP mode)

Rate limiting is always active in HTTP mode to prevent resource exhaustion. Before the MCP handler runs, each request is counted by resolved client IP against exactly one limit. In stateful mode, retained legacy POST requests with a currently live session use the session limit; modern sessionless POST requests and all other POST requests use the initialization limit, even if they present a live legacy `mcp-session-id`. GET/DELETE requests always use the session limit. In stateless mode, only a single parsed request object recognized by the SDK as `initialize` uses the initialization limit; all other POST bodies, including notifications and batches, use the session limit, and GET/DELETE still use the session limit. Malformed or oversized JSON is rejected by parsing before rate limiting or MCP server construction.

Each `MCP_RATE_*` value must be a positive decimal safe integer after JavaScript whitespace trimming. A leading `+` and leading zeros are accepted; fractions, suffixes, exponents, hexadecimal forms, non-positive values, and integers above `Number.MAX_SAFE_INTEGER` are rejected. An invalid value uses the documented default and emits one startup warning per variable without copying the raw value into diagnostics. Blank or unset variables use the default silently.

Before this correction, spellings such as `20requests`, `12.5`, or `1e3` could be accepted as numeric prefixes. They now fall back to the documented default, which may be looser or stricter than the value an older process effectively used. Check startup warnings and correct the environment value rather than relying on the fallback.

| Variable | Required | Default | Description |
|---|---|---|---|
| `MCP_RATE_WINDOW_MS` | No | `60000` | Sliding window duration in milliseconds for all rate limits |
| `MCP_RATE_INIT_MAX` | No | `20` | Max POST `/mcp` requests for modern sessionless traffic and requests without a currently live retained legacy session in stateful mode, plus SDK-recognized initialize requests in stateless mode. Guards initialization, invalid, unknown-session, stale-session, and legacy-session-header borrowing. |
| `MCP_RATE_SESSION_MAX` | No | `300` | Max POST `/mcp` requests for currently live retained legacy sessions and all GET/DELETE `/mcp` requests per window, including GET/DELETE requests with missing or invalid session IDs. Intentionally generous for AI agents. |

Requests exceeding a limit receive HTTP 429 with a JSON-RPC error body (`code: -32029`). `/health` has a fixed limit of 60 requests per minute. Standard `RateLimit-*` headers are included on all responses.

After a stateless request consumes its rate-limit token and passes authorization plus hardened Host/Origin checks, it must also acquire the per-IP and global in-flight capacity slots. Per-IP capacity is checked first. Saturation returns HTTP 503, `Retry-After: 1`, and JSON-RPC code `-32000` with message `Server busy`; these attempts still consume their selected rate-limit token. A request that exceeds its lifetime before response headers receives HTTP 504 and JSON-RPC code `-32000` with message `Stateless request timed out`. If an SSE response has already started, the connection is closed instead because its status can no longer be changed. Resource cleanup is bounded and capacity is reclaimed after completion, disconnect, failure, or timeout.

The in-memory rate-limit store is per process, so replicas do not share a quota.
The published package has no Redis-store configuration option. Adding a shared
store would require a source integration; account for independent limits when
scaling the current server.

## Tool Invocation Admission (all transports)

Tool invocation admission is a separate, process-local protection for MCP
`tools/call` work. It applies uniformly to STDIO, stateful HTTP sessions, and
stateless HTTP requests; it does not replace or change the HTTP request limiter
above. One busy session or transport can consume the shared process budget.

| Variable | Required | Default | Accepted range | Description |
|---|---|---:|---|---|
| `MCP_TOOL_RATE_WINDOW_MS` | No | `60000` | `1000`-`2147483647` | Fixed admission window in milliseconds. |
| `MCP_TOOL_RATE_MAX` | No | `300` | `1`-`10000` | Tool-call attempts admitted per fixed window. |
| `MCP_TOOL_MAX_IN_FLIGHT` | No | `16` | `1`-`256` | Hard no-queue ceiling for accepted tool calls executing at once. |

Values use the same strict safe-integer grammar as the HTTP rate controls:
surrounding whitespace, a leading `+` or `-`, and leading zeros are accepted,
but suffixes, fractions, exponents, unsafe integers, and out-of-range values
are rejected. Blank or unset values use their defaults silently. Each invalid
nonblank value falls back to its default and emits one startup-only stderr
warning naming the variable and fallback, never the supplied value. Values are
read once when the process starts.

```bash
MCP_TOOL_RATE_WINDOW_MS=60000
MCP_TOOL_RATE_MAX=300
MCP_TOOL_MAX_IN_FLIGHT=16
```

The window starts lazily with the first tool attempt and uses a monotonic clock.
It is an ordinary fixed window, so calls immediately on both sides of a window
boundary can produce a burst of up to twice the configured maximum. Every tool
attempt consumes a rate token, including malformed, unknown, and concurrency-
rejected calls. After rate admission, execution must acquire an in-flight slot;
there is no queue. A rejected call receives the stable retry-with-backoff tool
error without configured limits, counters, timing details, arguments, or other
call data.

Size the limits for expected workload and have clients back off on rejection.
Use separate process replicas when stronger tenant isolation is required. A
never-settling handler intentionally retains its in-flight slot until process
restart; this policy does not add a watchdog or alter existing cancellation and
timeout timing.

When HTTP mode runs behind a trusted reverse proxy, set `MCP_HTTP_TRUST_PROXY` so Express can resolve the client IP from proxy headers before rate-limit keys and request logs are computed. For a single trusted proxy hop, use `MCP_HTTP_TRUST_PROXY=1`. Leave it unset for direct exposure; enabling it without a trusted proxy lets clients spoof `X-Forwarded-For`. This setting is distinct from outbound `HTTP_PROXY` / `HTTPS_PROXY`, which control this server's requests to SearXNG or URLs.

Requests whose client IP cannot be resolved share one fail-closed capacity bucket. This prevents missing identity data from bypassing the per-IP cap, but such requests can receive HTTP 503 when another unresolved-IP request occupies that bucket.

## Hardened HTTP Mode

Opt-in security layer for when you expose the HTTP transport on a network. Default HTTP behavior is unchanged — hardening must be explicitly enabled with `MCP_HTTP_HARDEN=true`.

| Variable | Required | Default | Description |
|---|---|---|---|
| `MCP_HTTP_HARDEN` | No | `false` | Set to `true` to enable all hardening features |
| `MCP_HTTP_AUTH_TOKEN` | No | — | Static bearer token required for MCP requests in hardened static mode; incompatible with OAuth mode |
| `MCP_HTTP_ALLOWED_ORIGINS` | No | — | Comma-separated CORS origin allowlist (e.g. `https://app.example.com`) |
| `MCP_HTTP_ALLOWED_HOSTS` | No | `127.0.0.1`, `localhost`, `[::1]` (+ their `:PORT` forms) | Comma-separated DNS-rebinding allowlist. Entries are matched **exactly** against the request `Host` header, **including the port** (e.g. `app.example.com:8443`). Setting this replaces the default entirely. |
| `MCP_HTTP_ALLOW_PRIVATE_URLS` | No | `false` | Allow `web_url_read` to fetch internal/private URLs, including hostnames that DNS-resolve to private/internal addresses. Private URL reads are blocked by default in all modes. |
| `MCP_HTTP_EXPOSE_FULL_CONFIG` | No | `false` | In hardened mode, include configured `SEARXNG_URL` value(s), with URL credentials redacted, in the `config://server-config` MCP resource when this flag is `true`; when `false`, report only whether a URL is configured. Non-hardened mode always includes the redacted URL value(s). No effect on `/health`. |

`MCP_HTTP_ALLOWED_HOSTS` is compared against the raw `Host` header, which includes the port. The default already covers loopback access on the configured `MCP_HTTP_PORT` (`127.0.0.1:PORT`, `localhost:PORT`, `[::1]:PORT`) plus the bare hostnames, which match a portless `Host` — a client or reverse proxy that omits the port (as on ports 80/443). When you set it explicitly, list the exact `Host` the client (or your reverse proxy) sends — e.g. `app.example.com` if the proxy forwards `Host: app.example.com` on 443, or `app.example.com:8443` if it forwards a port.

### Origin validation and upgrade notice

Every present `Origin` on `/mcp` is validated in all modes; an absent `Origin` remains valid for non-browser clients. In non-hardened mode, an unset `MCP_HTTP_ALLOWED_ORIGINS` defaults to the exact HTTP/HTTPS loopback origins `http://127.0.0.1`, `https://127.0.0.1`, `http://localhost`, `https://localhost`, `http://[::1]`, and `https://[::1]`, both portless and with the configured `MCP_HTTP_PORT`. A non-empty `MCP_HTTP_ALLOWED_ORIGINS` replaces those defaults. Entries are trimmed but otherwise literal; matching is exact, case-sensitive literal matching, including scheme and port. Malformed, scheme-less, path-bearing, trailing slash, or differently-cased values silently do not match and must be corrected. Hardened mode still requires an explicit allowlist and adds authentication plus Host enforcement. An invalid present `Origin` on `/mcp` receives a fixed, non-reflecting 403 before parser, authentication, rate limiting, or transport construction. `/health` is outside the MCP 403 boundary but uses the narrowed global CORS allowlist. Before upgrading, existing non-hardened browser deployments using non-loopback Origins must set `MCP_HTTP_ALLOWED_ORIGINS` or receive a fixed 403. The transport support matrix above defines the modern sessionless and retained legacy boundaries.

## URL Reader Security

`web_url_read` blocks private/internal URLs by default in all transport modes. This includes localhost, loopback addresses, private IPv4 ranges, link-local addresses, `0.0.0.0/8`, CGNAT (`100.64.0.0/10`), IANA special-purpose IPv4 ranges, IPv6 loopback/ULA/link-local addresses, deprecated site-local (`fec0::/10`), multicast (`ff00::/8`), and decoded private IPv4 payloads from `::/96`, `::ffff:0:0/96`, `::ffff:0:0:0/96`, `2002::/16`, and `64:ff9b::/96`. The site-local range protects networks that still route it; the multicast denial is defense in depth. The entire `64:ff9b:1::/48` local-use range is a whole-prefix local-use denial before payload inspection.

These targeted decoded forms protect untrusted URL reading; they do not claim complete NAT64 or complete transition coverage. Teredo and Network-Specific Prefix forms are not decoded by this classifier.

Redirects are also checked before they are followed. A public URL that redirects to a private/internal URL is blocked.

For direct URL-reader requests without a proxy, DNS answers are validated before connecting. A public-looking hostname that resolves to a private/internal address is blocked, and the connection is pinned to the validated DNS answer to prevent DNS rebinding between validation and connection.

### Residual proxy-resolution boundary

When a URL-reader proxy is configured (`URL_READER_HTTP_PROXY`, `URL_READER_HTTPS_PROXY`, `HTTP_PROXY`, or `HTTPS_PROXY`), the proxy performs DNS resolution. Client-side DNS-answer validation cannot inspect proxied resolutions. Retain explicit proxy-side controls: restrict destinations at the proxy and use routing or firewall controls plus egress controls to protect internal networks.

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

Set `MCP_HTTP_ALLOW_PRIVATE_URLS=true` only when internal URL reads are intentional for your deployment. This also allows hostnames that DNS-resolve to private/internal addresses, including the site-local and multicast IPv6 ranges above.


<a id="combined-example-representative-options"></a>

## Configuration examples

Choose the example matching your transport. Setting `MCP_HTTP_PORT` selects
HTTP instead of STDIO; do not put it in a local STDIO client launcher.

### Local STDIO client

This client starts the server. Keep optional settings limited to what you need.

```json
{
  "mcpServers": {
    "searxng": {
      "command": "npx",
      "args": ["-y", "mcp-searxng"],
      "env": {
        "SEARXNG_URL": "https://search.example.com",
        "SEARXNG_MAX_RESULTS": "10"
      }
    }
  }
}
```

### Independent HTTP service

Start the service separately and connect the client to its full `/mcp` URL.
Use the [HTTP server guide](docs/http-server.md) for a complete static bearer
example, network assumptions and verification. In static mode,
`MCP_HTTP_HARDEN=true`, `MCP_HTTP_AUTH_TOKEN` and an explicit
`MCP_HTTP_ALLOWED_ORIGINS` must be configured together. Trust only the actual
proxy hops/subnets. With excessive trust, clients can spoof `X-Forwarded-For`.
Leaving proxy trust unset behind a proxy makes clients share its per-IP quota.

## Optional OAuth protected resource

The static bearer-token gate is a non-OAuth deployment control. For MCP OAuth
clients, configure an external authorization server to issue RFC 9068 JWT access
tokens for this resource, then set:

| Variable | Default | Meaning |
| --- | --- | --- |
| `MCP_HTTP_AUTH_MODE` | `static` | Set `oauth` to require OAuth on every MCP HTTP POST, GET and DELETE, independently of `MCP_HTTP_HARDEN`. |
| `MCP_HTTP_OAUTH_ISSUER` | unset | Exact HTTPS issuer identifier in the token's `iss` claim. |
| `MCP_HTTP_OAUTH_JWKS_URL` | unset | Trusted authorization server's HTTPS public signing-key endpoint. |
| `MCP_HTTP_OAUTH_RESOURCE` | unset | Public HTTPS MCP URL; tokens must include this exact audience. |
| `MCP_HTTP_OAUTH_SCOPES` | unset | Space-separated required scopes; every listed scope is required. |

All four OAuth settings are required in OAuth mode. URLs cannot contain userinfo,
query strings or fragments. Configuring OAuth settings in static mode, an unknown
mode, or a static `MCP_HTTP_AUTH_TOKEN` alongside OAuth prevents startup.

Example settings for an HTTPS reverse proxy forwarding `/mcp` and the discovery
path to this server:

```dotenv
MCP_HTTP_AUTH_MODE=oauth
MCP_HTTP_OAUTH_ISSUER=https://login.example.com
MCP_HTTP_OAUTH_JWKS_URL=https://login.example.com/.well-known/jwks.json
MCP_HTTP_OAUTH_RESOURCE=https://mcp.example.com/mcp
MCP_HTTP_OAUTH_SCOPES=mcp:tools mcp:resources
MCP_HTTP_HARDEN=true
MCP_HTTP_ALLOWED_ORIGINS=https://client.example.com
MCP_HTTP_ALLOWED_HOSTS=mcp.example.com
```

Keep TLS termination, allowed hosts/origins, bind address and trusted proxy
configuration appropriate for your deployment. OAuth adds authentication; it
does not configure your reverse proxy or replace these controls. Route
`/.well-known/oauth-protected-resource/mcp` without authentication to this server;
its public metadata advertises the resource, issuer and scopes. The metadata
path follows the configured resource path using RFC 9728. Do not rewrite that
path at the proxy. Clients also discover it through `WWW-Authenticate` on 401
and 403 responses; CORS exposes that header to allowed origins.

Send tokens in the `Authorization` header using the `Bearer` scheme, with `typ: at+jwt`, an RS256, PS256,
ES256 or EdDSA signature, `iss`, `aud`, `exp`, `iat`, nonempty `sub`, `client_id` and `jti`,
and a space-separated `scope` claim. Signature, issuer, resource audience, expiry,
activation time and scopes are checked on every request, including retained
legacy sessions. Each retained session is bound to the issuer, subject and client
that created it; a refreshed token for the same identity can continue using it.
ID tokens, opaque tokens and URL token parameters are not
accepted. The JWKS URL is operator configuration, never taken from a token.
Keys are fetched and cached by `jose`, including refresh for a new signing key.

This server is a protected resource, not an authorization server: login,
registration and token issuance belong to your provider. Opaque-token
introspection and immediate revocation are not implemented; locally verified
JWTs remain valid until expiry. Use short-lived access tokens. The MCP access
token is not forwarded as SearXNG credentials or included in error messages or
configuration resources. Static mode and STDIO remain available.
