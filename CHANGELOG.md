# Changelog

All notable changes to mcp-searxng are documented here.
Versions follow [Semantic Versioning](https://semver.org/).

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
