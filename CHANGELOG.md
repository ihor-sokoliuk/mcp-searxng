# Changelog

All notable changes to mcp-searxng are documented here.
Versions follow [Semantic Versioning](https://semver.org/).

## [1.10.1] - 2026-07-04

### Fixed

- **`USER_AGENT` now applied to the `/config` and suggestions requests:** The configured `USER_AGENT` header is now sent on the SearXNG `/config` instance-info fetch and on search-suggestion fetches. These two paths previously always used the default agent while the main search and `web_url_read` paths already honored `USER_AGENT`, so instances that filter or rate-limit by User-Agent behaved inconsistently. The header is now merged in one shared request-config helper covering every outbound instance request. (BUG-009, [#145](https://github.com/ihor-sokoliuk/mcp-searxng/pull/145))

### Security

- **SSRF guard now blocks CGNAT and the remaining IANA special-purpose IPv4 ranges:** The private-address guard that protects `web_url_read` — and the DNS-rebinding lookup hook that re-validates every resolved answer — previously only rejected RFC1918, loopback, link-local, and `0.0.0.0/8`. It now also blocks CGNAT (`100.64.0.0/10`, Tailscale's default range plus container overlays and ISP CGNAT), the TEST-NET ranges, benchmarking (`198.18.0.0/15`), IETF protocol assignments (`192.0.0.0/24`), 6to4 relay anycast, multicast (`224.0.0.0/4`), and reserved/broadcast (`240.0.0.0/4`). All blocked ranges are consolidated into a single auditable CIDR table (RFC 6890) enforced at both the literal-hostname and DNS-resolved paths; IPv4-mapped IPv6 delegates here and is covered too. (SEC-024, [#147](https://github.com/ihor-sokoliuk/mcp-searxng/pull/147))

## [1.10.0] - 2026-07-03

### Added

- **Content-type-aware `web_url_read`:** The URL reader now inspects the response `Content-Type` before converting. HTML is converted to markdown as before; JSON (`application/json` and `*+json`) is pretty-printed in a fenced block; and plain text, YAML, TOML, and XML are returned as readable fenced text. Binary, media, archive, and PDF responses are now rejected with a short hint instead of being decoded into unreadable bytes — fixing the case where fetching a PDF URL fed garbage to the model. Responses whose declared type is missing or generic are sniffed for a NUL byte in the first kilobyte and rejected if they look binary, which also catches binaries mislabeled as `text/plain`; anything textual continues through the existing HTML pipeline unchanged. (FEAT-045, [#142](https://github.com/ihor-sokoliuk/mcp-searxng/pull/142), resolves [#133](https://github.com/ihor-sokoliuk/mcp-searxng/issues/133))

- **Actionable errors when a SearXNG instance returns non-JSON:** When a search gets a `200` response whose body is not JSON — an HTML results page because the instance never enabled `format: json`, or a Cloudflare/WAF interstitial — the error now names both fixes (enable `- json` under `search.formats` in the instance's `settings.yml`, or set `SEARXNG_HTML_FALLBACK=true`) while still including the response preview, instead of failing with an opaque "Invalid JSON format". (FEAT-053, [#141](https://github.com/ihor-sokoliuk/mcp-searxng/pull/141), resolves [#137](https://github.com/ihor-sokoliuk/mcp-searxng/issues/137))

- **Documented `NODE_EXTRA_CA_CERTS` for Windows and corporate-proxy TLS:** A new "TLS / Corporate CA" section in `CONFIGURATION.md` explains that Linux and macOS auto-detect the system CA bundle, while Windows users behind a TLS-inspecting corporate proxy (Zscaler, Netskope, Palo Alto, Blue Coat) must export the proxy's root CA to PEM and point the standard Node.js `NODE_EXTRA_CA_CERTS` variable at it — with the PowerShell export steps and an explicit warning never to use the insecure `NODE_TLS_REJECT_UNAUTHORIZED=0`. No code change; the variable was already honored by Node/undici. (FEAT-054, [#143](https://github.com/ihor-sokoliuk/mcp-searxng/pull/143), resolves [#138](https://github.com/ihor-sokoliuk/mcp-searxng/issues/138))

## [1.9.0] - 2026-07-02

### Added

- **Configurable Express `trust proxy` for HTTP mode (`MCP_HTTP_TRUST_PROXY`):** When the Streamable HTTP transport runs behind a trusted reverse proxy, set `MCP_HTTP_TRUST_PROXY` so Express resolves the real client IP from `X-Forwarded-For` before computing rate-limit keys and request logs. Accepts `true`, a trusted hop count such as `1`, or a subnet/preset such as `loopback` or `10.0.0.0/8`; unset, `false`, or `0` disables it, which stays the secure default (enabling it without a real proxy in front lets clients spoof `X-Forwarded-For`). This is distinct from the outbound `HTTP_PROXY` / `HTTPS_PROXY` settings that govern this server's own requests. (FEAT-051, [#140](https://github.com/ihor-sokoliuk/mcp-searxng/pull/140))

### Fixed

- **HTTP session recovered after a server restart:** The Streamable HTTP `sessions` map is in-memory, so a client that reused its `mcp-session-id` across a server restart got wedged — a fresh `initialize` still carried the stale header and fell through to `400 / -32000`. `initialize` is now accepted regardless of any stale session header, and unknown session IDs on non-`initialize` POSTs return `404 / -32001 "Session not found"` (matching the MCP SDK's own shape) so clients can detect a dead session and re-initialize. (BUG-010, [#139](https://github.com/ihor-sokoliuk/mcp-searxng/pull/139))

- **Search JSON-parse errors keep the real response preview:** A `fetch` response body is single-use, and the old path called `response.text()` in the catch after `response.json()` had already consumed it, so a JSON-parse failure always degraded to `[Could not read response text]`. The body is now read as text first and then parsed, so the error carries the actual response preview — making misconfigured or HTML-returning instances far easier to diagnose. (BUG-008, [#131](https://github.com/ihor-sokoliuk/mcp-searxng/pull/131))

### Security

- **`SEARXNG_URL` credentials redacted in errors, logs, and provenance:** Embedded userinfo (`user:pass@host`) in `SEARXNG_URL` no longer leaks into model-visible error messages, client logs, or `servedBy` provenance. A shared redaction helper is now applied at every instance-URL emission point — the aggregate failover error, the `ECONNREFUSED` nested message, request/fallback logs, error context, and `servedBy`. (BUG-007, [#136](https://github.com/ihor-sokoliuk/mcp-searxng/pull/136))

## [1.8.0] - 2026-06-23

### Added

- **Multi-instance failover and optional parallel fanout for `SEARXNG_URL`:** `SEARXNG_URL` now accepts several semicolon-separated SearXNG replica URLs that are treated as interchangeable. In the default failover mode a search tries each instance in order until one returns results; an instance with 3 consecutive hard failures is skipped for 60 seconds, while a `200 OK` with an empty result set is treated as healthy and does not trigger cooldown. Set the new `SEARXNG_FANOUT=true` to instead query all healthy instances in parallel and merge results — deduplicated by canonical URL, keeping the highest-scoring copy and ordered by descending score. A single-URL `SEARXNG_URL` behaves exactly as before, so no configuration change is required. (FEAT-047, [#128](https://github.com/ihor-sokoliuk/mcp-searxng/pull/128))

- **Capability discovery aggregated across all instances for filter guidance:** `searxng_instance_info` and the `categories`/`engines` search parameters now aggregate live `/config` capabilities from every reachable configured instance instead of a single one. The tool reports `common` categories and engines (supported on every reachable instance, so safe for consistent multi-instance results) alongside best-effort `available` values, keeping filter guidance accurate when replicas differ in their enabled engines. A `/config` endpoint that fails is skipped for about 60 seconds, or retried immediately when `searxng_instance_info` is called with `refresh=true`. (FEAT-048, [#130](https://github.com/ihor-sokoliuk/mcp-searxng/pull/130))

### Fixed

- **`safesearch` accepted as a string enum and honoring the instance default when omitted:** `safesearch` is now declared as a string enum (`"0"`, `"1"`, `"2"`) so MCP clients that send every tool argument as a string — notably Gemini and Antigravity — no longer fail schema validation. The schema default was also dropped, so omitting `safesearch` now falls back to each instance's server-side default instead of forcing a value. (BUG-006, [#127](https://github.com/ihor-sokoliuk/mcp-searxng/pull/127))

- **Docker Compose HTTP transport reachable from the host:** The HTTP transport in the provided `docker-compose` setup now binds to `0.0.0.0` instead of a loopback address, so the mapped port is reachable from the host rather than only from inside the container.

## [1.7.2] - 2026-06-20

### Security

- **Container image now runs as a non-root user (UID 1000):** The published Docker image previously ran as `root`, so Kubernetes deployments using the `runAsNonRoot: true` pod security context were rejected at admission. The image now sets a numeric `USER 1000` (the `node` account already present in the `node:lts-alpine` base), which satisfies `runAsNonRoot` without an additional `runAsUser` override and reduces the container's blast radius. No configuration change is required. (Reported by @nogweii, [#122](https://github.com/ihor-sokoliuk/mcp-searxng/issues/122))

## [1.7.1] - 2026-06-18

### Security

- **DNS-resolved private-address SSRF in `web_url_read` blocked (GHSA-mrvx-jmjw-vggc):** The URL reader previously validated only the literal hostname string, so a public-looking hostname that DNS-resolves to a private, loopback, or link-local address (for example a domain pointing at `127.0.0.1`/`10.0.0.0/8` or a cloud metadata endpoint like `169.254.169.254`) bypassed the SSRF guard. Direct (no-proxy) reads now validate every resolved DNS answer before connecting and pin the connection to the validated address, closing the DNS-rebinding window. The `MCP_HTTP_ALLOW_PRIVATE_URLS=true` opt-out still applies. When a URL-reader proxy is configured the proxy performs DNS resolution, so those deployments must rely on egress/firewall controls (documented in `SECURITY.md`).
- **Unbounded response-body read in `web_url_read` capped (GHSA-xcqx-9jf5-w339):** The page-size limit was advisory only — a server using chunked transfer encoding, a failing/absent HEAD response, or a body larger than its reported `Content-Length` could force the entire response into memory (denial of service). The body is now read through a bounded stream that enforces `URL_READ_MAX_CONTENT_LENGTH_BYTES` (default 5 MB) against the decompressed size and stops once the cap is exceeded, before any conversion or caching.

## [1.7.0] - 2026-06-18

### Added

- **HTML-search fallback (`SEARXNG_HTML_FALLBACK=true`):** Opt-in compatibility mode for SearXNG instances that disable JSON output. When a search hits a `403`/`404` or a non-JSON response, it is automatically retried without `format=json` and results (title, URL, snippet) are parsed from the regular HTML results page and marked `sourceFormat: "html"`. Triggers strictly on format rejections — never on `401`, `5xx`, network, or timeout errors. Enabling JSON on a SearXNG instance you control remains the recommended setup; see the README troubleshooting section.

### Security

- **`undici` upgraded to 7.28.0** — resolves two HIGH advisories affecting 7.0.0–7.27.2: GHSA-vmh5-mc38-953g (TLS certificate validation bypass in the SOCKS5 ProxyAgent) and GHSA-pr7r-676h-xcf6 (cross-user information disclosure via shared-cache whitespace bypass).
- **`form-data` upgraded to 4.0.6** — clears a CRLF-injection advisory (GHSA-hmw2-7cc7-3qxx) in the test toolchain.

## [1.6.0] - 2026-06-16

### Added

- **`engines` parameter on `searxng_web_search`:** A comma-separated list routes a search to specific SearXNG engines (e.g. `google,bing,duckduckgo`) instead of the category defaults. Omitting it preserves the previous behaviour.

- **Validated & normalized `categories` / `engines`:** Values are now trimmed and matched case-insensitively against the connected instance's live `/config`, and the canonical names are sent to SearXNG. Unknown values are rejected up front with the available options listed — fixing silent search degradation from miscased or invalid engine/category names.

- **Configurable URL cache controls:** `CACHE_TTL_MS` sets the URL cache TTL (default `86400000` ms = 24 h) and `CACHE_MAX_ENTRIES` sets the maximum cached URLs (default `500`).

- **Bounded URL cache eviction:** URL cache entries now track hit counts and use LFU eviction with oldest-entry tie-breaking, keeping the cache within the configured size limit.

### Changed

- **URL cache TTL default:** The URL cache now reuses cached pages for up to 24 h within a running server unless entries expire or are evicted. Previous default was 60 s.

### Security

- **Least-privilege Docker workflow permissions:** `security-events: write` is now isolated to a dedicated image-scan job in both the publish and rebuild workflows, with `id-token: write` confined to the publish/sign job and workflow-level permissions kept read-only.

- **Patched bundled `hono`:** Pinned the transitive `hono` dependency to ≥ 4.12.25 (via npm `overrides`) to resolve CVE-2026-54290 — a CORS middleware flaw that reflected any origin with credentials — in the published Docker image.

### Build / CI

- Added a CI workflow that runs lint plus unit and integration tests on every pull request and push to `main`.

## [1.5.0] - 2026-06-12

### Added

- **`searxng_suggestions` tool:** Returns search autocomplete suggestions from the SearXNG instance. Useful for exploring related queries before committing to a full search.

- **`searxng_instance_info` tool:** Discovers the capabilities of the connected SearXNG instance — enabled engines, supported categories, available languages, and safe-search settings.

- **JSON response format:** `searxng_web_search` accepts a new `response_format` parameter (`"text"` or `"json"`). The `"json"` format returns raw structured data instead of the formatted Markdown text, enabling programmatic result processing.

- **Search metadata in text output:** `searxng_web_search` text responses now include SearXNG answers, spelling corrections, infoboxes, and autocomplete suggestions when the instance returns them — giving richer context alongside the ranked web results.

### Fixed

- Metadata (answers, corrections, infoboxes) is now preserved in text output even when `min_score` filters out all web results. Previously the metadata was silently dropped.

- Unresponsive engines are no longer listed in text output.

- `searxng_suggestions` and `searxng_instance_info` requests now route through the configured search proxy and default TLS dispatcher, matching the behaviour of `searxng_web_search`.

## [1.4.0] - 2026-06-11

### Added

- **Result count control:** `num_results` parameter on `searxng_web_search` (1–20) lets callers request only as many results as they need. `SEARXNG_MAX_RESULTS` env var sets an operator-level hard cap that applies even when `num_results` is omitted — useful for reducing token spend across all callers.

- **Token budget limits:** `SEARXNG_MAX_RESULT_CHARS` env var truncates each search result snippet to a character limit (appending `…`) before returning. `URL_READ_MAX_CHARS` env var sets a default `maxLength` for URL reads when the caller omits it — both controls are recommended for local models with small context windows.

- **HEAD preflight for URL reader:** A fast HEAD request is made before every URL fetch to check `Content-Length`. If the server reports a size above `URL_READ_MAX_CONTENT_LENGTH_BYTES` (default 5 MB), the download is blocked and a descriptive message with `readHeadings`/`section` pagination hints is returned instead of downloading an unbounded body.

- **`categories` parameter on `searxng_web_search`:** Routes searches to specific SearXNG categories — `general`, `news`, `images`, `videos`, `it`, `science`, `files`, `social media`. Omitting the parameter uses the SearXNG instance default (`general`).

- **Configurable search defaults:** `SEARXNG_DEFAULT_LANGUAGE` and `SEARXNG_DEFAULT_SAFESEARCH` env vars set operator-level defaults for language and safe-search level. Per-call parameters still take precedence. Invalid `SEARXNG_DEFAULT_SAFESEARCH` values (not `0`, `1`, or `2`) are logged and ignored.

- **Configurable timeouts:** `SEARXNG_TIMEOUT_MS` controls the search request timeout and `FETCH_TIMEOUT_MS` controls the URL reader fetch timeout (both default to `10000` ms).

- **Lite tool schemas (`SEARXNG_LITE_TOOLS=true`):** When set, registers minimal `query`-only and `url`-only tool schemas instead of the full parameter list. Reduces context overhead for local models with small context windows while still forwarding any extra arguments the caller provides.

### Security

- Pinned the npm trusted publishing installer step in the publish workflow to a full commit SHA to guard against tag-swap supply-chain attacks.

## [1.3.4] - 2026-06-11

### Security
- Docker images are now signed with Cosign (keyless OIDC). Verify a published image with:
  ```bash
  cosign verify docker.io/isokoliuk/mcp-searxng:latest \
    --certificate-identity-regexp 'https://github.com/ihor-sokoliuk/mcp-searxng/.github/workflows/docker-publish.yml@.*' \
    --certificate-oidc-issuer https://token.actions.githubusercontent.com
  ```
- Expanded fuzz test coverage: search parameter handling and URL read arguments are now fuzz-tested on every CI run.
- Tightened GitHub Actions workflow permissions to least-privilege and switched to reproducible `npm ci` installs in the publish pipeline.

## [1.3.3] - 2026-06-10

### Fixed
- `test:coverage` script now enforces the coverage threshold mechanically.
- Gitignored AI process artifacts (plans, drafts) so they can never be committed.

### Security
- Docker base image (`node:lts-alpine`) is now pinned by digest and bumped automatically via Dependabot.
- Added a weekly rebuild workflow: when upstream patches the base image, the published Docker image is rebuilt from the latest release tag, re-scanned with Trivy, and republished under the same version tags. Published images now embed the `org.opencontainers.image.base.digest` OCI label for auditability.

## [1.3.2] - 2026-06-09

### Fixed
- Expanded `SearXNGWeb` response interface to include all fields returned by the API.
- Search requests now use `AbortController` to enforce the configured timeout and prevent hanging.

### Security
- Pinned all GitHub Actions workflow steps to full commit SHAs to guard against tag-swap supply-chain attacks.
- Added CodeQL static analysis, Trivy Docker image scanning, and ClusterFuzzLite continuous fuzzing.
- Added Dependabot for automated npm and GitHub Actions dependency updates.
- Verified `mcp-publisher` binary integrity with SHA-256 checksum before use.

## [1.3.1] - 2026-06-09

### Fixed
- Hotfix: corrected `bin` entry in `package-lock.json` that caused install failures in some environments.

## [1.3.0] - 2026-06-09

### Fixed
- Server silently exiting when launched via `npx`, Claude Desktop, opencode, or mcpo (#91). Root cause: the `isMainModule` path comparison introduced in v1.2.0 fails when Node runs through an npm `.bin/` symlink. Replaced with a dedicated `src/cli.ts` entrypoint — works on every Node version and invocation method.

### Security
- **Breaking:** HTTP server now binds to `127.0.0.1` by default instead of `0.0.0.0`. Operators who need network-wide access must opt in with `MCP_HTTP_HOST=0.0.0.0`.
- Added `express-rate-limit` to all HTTP routes — configurable via `MCP_RATE_WINDOW_MS`, `MCP_RATE_INIT_MAX`, `MCP_RATE_SESSION_MAX`.

## [1.2.1] - 2026-06-07

### Fixed
- Hotfix for issue #91 (server exit on npx invocation).

## [1.2.0] - 2026-06-07

### Added
- `week` option for `searxng_web_search` `time_range` parameter.
- `min_score` filter parameter for `searxng_web_search`.

### Security
- Added `MCP_HTTP_AUTH_TOKEN` bearer token authentication for HTTP transport.
- Enabled TLS certificate verification options (`MCP_TLS_*`).

## [1.1.1] - 2026-06-06

### Fixed
- Minor stability fixes for HTTP transport.

## [1.1.0] - 2026-06-03

### Added
- `MCP_HTTP_HOST` environment variable to customise server address binding.

### Fixed
- URL fetch tool (`web_url_read`) reliability improvements.

## [1.0.4] - 2026-05-23

### Fixed
- Escape user input in `extractSection` regex to prevent ReDoS (CWE-1333) (#71).
- Add `mcp-protocol-version` to CORS `allowedHeaders` (#77).

### Documentation
- Improved `searxng_web_search` tool description to prevent LLM using `prompt` instead of `query` (#80).

## [1.0.3] - 2026-04-05

### Fixed
- Create a new `McpServer` per HTTP session to prevent `Already connected` crash (#66).

## [1.0.1] - 2026-04-01

### Changed
- Enhanced `SEARXNG_URL` validation, error handling, and documentation (#64).

## [0.10.1] - 2026-03-30

### Security
- Updated all dependencies to latest versions to address known vulnerabilities.
