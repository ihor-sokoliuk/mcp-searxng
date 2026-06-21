# Changelog

All notable changes to mcp-searxng are documented here.
Versions follow [Semantic Versioning](https://semver.org/).

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
