<div align="center">

# 🔍 SearXNG MCP Server

**Privacy-respecting web search for AI assistants — use an operator-controlled or trusted SearXNG instance with Claude, Cursor, and more.**

[![GitHub Stars](https://img.shields.io/github/stars/ihor-sokoliuk/mcp-searxng?style=flat-square&logo=github&label=stars)](https://github.com/ihor-sokoliuk/mcp-searxng/stargazers)
[![npm version](https://img.shields.io/npm/v/mcp-searxng?style=flat-square&logo=npm)](https://www.npmjs.com/package/mcp-searxng)
[![npm downloads](https://img.shields.io/npm/dm/mcp-searxng?style=flat-square&logo=npm&label=downloads%2Fmo)](https://www.npmjs.com/package/mcp-searxng)
[![Docker Pulls](https://img.shields.io/docker/pulls/isokoliuk/mcp-searxng?style=flat-square&logo=docker)](https://hub.docker.com/r/isokoliuk/mcp-searxng)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/ihor-sokoliuk/mcp-searxng/badge)](https://scorecard.dev/viewer/?uri=github.com/ihor-sokoliuk/mcp-searxng)
[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/13143/badge)](https://www.bestpractices.dev/projects/13143)
[![mcp-searxng MCP server](https://glama.ai/mcp/servers/ihor-sokoliuk/mcp-searxng/badges/score.svg)](https://glama.ai/mcp/servers/ihor-sokoliuk/mcp-searxng)
[![GitHub MCP Registry](https://img.shields.io/badge/GitHub_MCP_Registry-listed-2da44e?style=flat-square&logo=github&logoColor=white)](https://github.com/mcp/ihor-sokoliuk/mcp-searxng)

An [MCP server](https://modelcontextprotocol.io/introduction) that integrates the [SearXNG](https://docs.searxng.org) API, giving AI assistants web search capabilities.

✨ Featured in the [GitHub MCP Registry](https://github.com/mcp/ihor-sokoliuk/mcp-searxng).

</div>

## Quick Start

Add to your MCP client configuration (e.g. `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "searxng": {
      "command": "npx",
      "args": ["-y", "mcp-searxng"],
      "env": {
        "SEARXNG_URL": "YOUR_SEARXNG_INSTANCE_URL"
      }
    }
  }
}
```

Replace `YOUR_SEARXNG_INSTANCE_URL` with the URL of your SearXNG instance (e.g. `https://searxng.example.com`). You can also provide interchangeable replicas as a semicolon-separated list, e.g. `https://one.example.com;https://two.example.com`.

For verified Claude Desktop, Claude Code, Codex CLI, Cursor, VS Code, Windsurf,
Cline, and OpenCode recipes, see the
[MCP client configuration cookbook](docs/client-configurations.md).

For a bounded, client-neutral method to search, inspect sources, cross-check
claims, and cite evidence, see the
[evidence-focused research workflow](docs/research-workflow.md).

For measured MCP-process CPU and memory starting points, see
[measured deployment profiles](docs/deployment-profiles.md).

## Features

- **Web Search**: General, news, and article queries with pagination, time-range/language/safe-search filters, relevance filtering (`min_score`), and formatted-text or raw-JSON output (`response_format`).
- **Instance Failover & Fan-out**: Configure interchangeable SearXNG replicas in `SEARXNG_URL`; searches fail over in order by default, or query all healthy replicas in parallel and merge results with `SEARXNG_FANOUT`.
- **Direct Answers & Metadata**: Text results surface SearXNG answers, corrections, suggestions, and infoboxes before the result list.
- **Search Suggestions**: Query autocomplete via SearXNG's `/autocompleter` endpoint.
- **Instance Capability Discovery**: Inspect configured categories, engines, defaults, locales, and plugins from `/config`.
- **URL Content Reading**: Content-type-aware Markdown conversion, including bounded PDF text extraction, with pagination, section filtering, paragraph ranges, and heading extraction.
- **Browser Solver Support**: For each uncached URL that passes URL validation and the HEAD size preflight, optionally acquire a browser session from either FlareSolverr or Byparr, then replay the returned user-agent and scoped cookies through the bounded URL reader. FlareSolverr 3.5.0 and Byparr 2.1.0 were verified on 2026-07-30. Configure exactly one provider; automatic cross-provider fallback is not enabled.
- **Intelligent Caching**: Both search results and URL content are cached in memory with configurable TTL and least-frequently-used (LFU) eviction, reducing redundant requests.
- **SSRF Protection**: `web_url_read` blocks private/internal URLs and redirects by default in all transport modes.
- **HTTP Transport**: Optional Streamable HTTP mode with opt-in hardening — bearer-token auth, CORS allowlist, and rate limiting.
- **HTML Fallback**: Optionally parse results from the HTML page for public instances that reject `format=json`.
- **Lite Tools Mode**: Minimal tool schemas for local models with small context windows.
- **Proxy Support**: Global or per-tool HTTP/HTTPS proxies for search and URL-reader traffic.

The verified `linux/amd64` images came from multi-architecture manifests
`ghcr.io/flaresolverr/flaresolverr:v3.5.0@sha256:139dfee1c6f89249c8d665d1333a42e8ec74ec0a86bc6bb1c8461e10d3a66a47`
and
`ghcr.io/thephaseless/byparr:2.1.0@sha256:01a46a2865d9a6db5eb8ead04ec0dd33b8fbe233e8565ae70b50d4cc0af4cfb0`.
Client cancellation stops local work promptly, but a remote browser may
continue until its configured provider timeout after the HTTP client
disconnects. See [browser solver verification](docs/browser-solver-verification.md).

## Why mcp-searxng?

As of 2026-07-29, the capability comparison below reflects the official
[Brave MCP](https://github.com/brave/brave-search-mcp-server),
[Exa MCP](https://github.com/exa-labs/exa-mcp-server), and
[Firecrawl MCP](https://github.com/mendableai/firecrawl-mcp-server) projects.
“Pagination” means an exposed page or offset control. “Self-hosted” means the
search service can run under your control. “Free / No API key” means this MCP
server does not require a paid search-vendor API key; you still operate or
select the underlying SearXNG instance.

| | Brave MCP | Exa MCP | Firecrawl MCP | **mcp-searxng** |
|--|:---------:|:-------:|:-------------:|:---------------:|
| Web Search | ✓ | ✓ | ✓ | ✓ |
| Read URL | ✗ | ✓ | ✓ | ✓ |
| Pagination | ✓ | ✗ | ✓ | ✓ |
| Self-hosted | ✗ | ✗ | Partial | ✓ |
| Free / No API key | ✗ | ✗ | ✗ | ✓ |

Privacy depends on the SearXNG deployment. An operator-controlled instance can
avoid trusting a third-party search operator, while a public instance receives
the query and may log it. SearXNG and this MCP integration do not by themselves
provide anonymity.

## How It Works

`mcp-searxng` is a standalone MCP server — a separate Node.js process that your AI assistant connects to for web search. It queries one SearXNG instance, or a semicolon-separated list of interchangeable SearXNG replicas, via the HTTP JSON API.

> **Not a SearXNG plugin:** This project cannot be installed as a native SearXNG plugin. Point it at any existing SearXNG instance, or interchangeable replica list, by setting `SEARXNG_URL`.

```
AI Assistant (e.g. Claude)
        │  MCP protocol
        ▼
  mcp-searxng  (this project — Node.js process)
        │  HTTP JSON API  (SEARXNG_URL)
        ▼
  SearXNG instance(s)
```

For SearXNG deployment, configuration, and troubleshooting, see
[Operating Self-Hosted SearXNG with mcp-searxng](docs/self-hosted-searxng.md).

## Tools

- **searxng_web_search**
  - Execute web searches with pagination
  - Inputs:
    - `query` (string): The search query. This string is passed to external search services.
    - `pageno` (number, optional): Search page number, starts at 1 (default 1)
    - `time_range` (string, optional): Filter results by time range - one of: "day", "week", "month", "year" (default: none)
    - `language` (string, optional): Language code for results (e.g., "en", "fr", "de") or "all" (default: "all")
    - `safesearch` (string enum, optional): Safe search filter level, one of `"0"` (None), `"1"` (Moderate), or `"2"` (Strict). Legacy numeric values `0`, `1`, and `2` are still accepted for backward compatibility. (default: instance setting)
    - `min_score` (number, optional): Minimum relevance score from 0.0 to 1.0. Results below this score are filtered out.
    - `num_results` (number, optional): Maximum number of results to return, from 1 to 20. `SEARXNG_MAX_RESULTS` applies as an operator ceiling.
    - `categories` (string, optional): Comma-separated SearXNG categories (e.g. `"news"`, `"it,science"`). Live `/config` capabilities are aggregated across reachable instances; prefer `searxng_instance_info` `categories.common` for consistent multi-instance results. Known values are trimmed and normalized case-insensitively; unknown values are forwarded trimmed so SearXNG can ignore or honor them. If `/config` is unavailable, values are forwarded as-is with a warning. If omitted, each instance uses its server-side default.
    - `engines` (string, optional): Comma-separated SearXNG engine names (e.g. `"google,bing,ddg"`, `"semantic scholar"`). Live `/config` capabilities are aggregated across reachable instances; prefer `searxng_instance_info` `engines.common.enabled` for consistent multi-instance results. Known values are trimmed and normalized case-insensitively, including engines disabled by default; unknown values are forwarded trimmed so SearXNG can ignore or honor them. If `/config` is unavailable, values are forwarded as-is with a warning. If omitted, each instance uses its server-side default.
    - `response_format` (string, optional): Response format, either `"text"` for formatted agent-readable output or `"json"` for raw SearXNG JSON with filtered/sliced `results`. (default: `"text"`)

- **searxng_search_suggestions**
  - Get autocomplete suggestions for refining search queries
  - Inputs:
    - `query` (string): Partial or complete query to autocomplete.
    - `language` (string, optional): Language code for suggestions (e.g., "en", "fr", "de") or "all" (default: "all")

- **searxng_instance_info**
  - Discover categories aggregated from reachable configured SearXNG instances, optionally include engine names, and inspect defaults, locales, and plugins from the primary reachable instance. Categories—and engines when requested—report `common` values present on every reachable instance and `available` values present on at least one reachable instance.
  - Inputs:
    - `includeEngines` (boolean, optional): Include enabled engine names in the response. (default: false)
    - `includeDisabled` (boolean, optional): Include disabled engine names when `includeEngines` is true. (default: false)
    - `category` (string, optional): Filter categories and engines to a single category name.
    - `refresh` (boolean, optional): Bypass the process cache and fetch fresh `/config` data. (default: false)

- **web_url_read**
  - Read URL content as markdown with content-type-aware handling and advanced extraction options
  - Supported readable content:
    - HTML (`text/html`, `application/xhtml+xml`) is converted to markdown
    - JSON (`application/json`, `*+json`) is pretty-printed in a fenced block
    - Plain text, YAML, TOML, XML, and other safe explicit `text/*` responses are returned as readable fenced text
    - PDF (`application/pdf`) text is extracted in a resource-bounded worker for documents up to 500 pages
    - Missing or generic content types are read under the existing size cap; non-binary bodies continue through the HTML-to-markdown path for compatibility
  - PDF input and extracted text are each capped at the lower of `URL_READ_MAX_CONTENT_LENGTH_BYTES` and 16 MiB. OCR is not supported, and scanned/image-only or password-protected PDFs return a short explanation.
  - A response declared as PDF must begin with the `%PDF-` signature; a mismatch usually indicates an interstitial or error page served with the wrong content type.
  - PDF parsing has a separate 30-second worker budget after the response body is downloaded. On the direct path, the network fetch and parse take at most the configured fetch budget plus 30 seconds; configured browser-solver preflight and acquisition time is additional.
  - At most two PDF extractions run concurrently per MCP process. There is no queue; additional concurrent reads return a busy message and may be retried.
  - Other binary, media, archive, and octet-stream downloads are intentionally rejected with a short hint instead of returning raw bytes
  - When `FLARESOLVERR_URL` or `BYPARR_URL` is configured, an uncached URL is validated and checked by the HEAD size preflight before `mcp-searxng` attempts browser-session acquisition. Cache hits bypass acquisition; a full provider-specific concurrency limit and transient solver failures use an uncached direct-fetch fallback. When a solver slot is available, every uncached URL that passes URL validation and the HEAD size preflight is disclosed to the configured browser solver.
  - Inputs:
    - `url` (string): The URL to fetch and process
    - `startChar` (number, optional): Starting character position for content extraction (default: 0)
    - `maxLength` (number, optional): Maximum number of characters to return
    - `section` (string, optional): Extract content under a specific heading (searches for heading text)
    - `paragraphRange` (string, optional): Return specific paragraph ranges (e.g., '1-5', '3', '10-')
    - `readHeadings` (boolean, optional): Return only a list of headings instead of full content

## Installation

Requires Node.js 20 or later.

<details>
<summary>NPM (global install)</summary>

```bash
npm install -g mcp-searxng
```

```json
{
  "mcpServers": {
    "searxng": {
      "command": "mcp-searxng",
      "env": {
        "SEARXNG_URL": "YOUR_SEARXNG_INSTANCE_URL"
      }
    }
  }
}
```

</details>

<details>
<summary>Docker</summary>

**Pre-built image:**

```bash
docker pull isokoliuk/mcp-searxng:latest
```

Image signatures can be verified with Cosign — see [SECURITY.md](SECURITY.md) for instructions.

```json
{
  "mcpServers": {
    "searxng": {
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "SEARXNG_URL",
        "isokoliuk/mcp-searxng:latest"
      ],
      "env": {
        "SEARXNG_URL": "YOUR_SEARXNG_INSTANCE_URL"
      }
    }
  }
}
```

To pass additional env vars, add `-e VAR_NAME` to `args` and the variable to `env`.
For browser-solver integration, pass either `FLARESOLVERR_URL` or `BYPARR_URL`
and make that service reachable from this container. See
[URL Reader Controls](CONFIGURATION.md#url-reader-controls) for the complete
behavior and Docker Compose example.

**Build locally:**

```bash
docker build -t mcp-searxng:latest -f Dockerfile .
```

Use the same config above, replacing `isokoliuk/mcp-searxng:latest` with `mcp-searxng:latest`.

</details>

<details>
<summary>Docker Compose</summary>

`docker-compose.yml`:

```yaml
services:
  mcp-searxng:
    image: isokoliuk/mcp-searxng:latest
    stdin_open: true
    environment:
      - SEARXNG_URL=${SEARXNG_URL:?Set SEARXNG_URL in the environment}
      # Add optional variables as needed — see CONFIGURATION.md
```

The tracked Compose file is intentionally STDIO-only and publishes no network ports; MCP clients launch it with an absolute Compose-file path and `docker compose run --rm -T`, not `docker compose up`. The `-T` flag prevents pseudo-TTY allocation so MCP JSON-RPC stays on raw standard input and output. Compose fails before launch unless the MCP client supplies `SEARXNG_URL`.

MCP client config:

```json
{
  "mcpServers": {
    "searxng": {
      "command": "docker",
      "args": [
        "compose",
        "-f", "/absolute/path/to/docker-compose.yml",
        "run", "--rm", "-T", "mcp-searxng"
      ],
      "env": {
        "SEARXNG_URL": "YOUR_SEARXNG_INSTANCE_URL"
      }
    }
  }
}
```

If you previously used the tracked file as an HTTP service on port 8080, put the HTTP settings in an untracked `docker-compose.override.yml`:

```yaml
services:
  mcp-searxng:
    ports:
      - "127.0.0.1:8080:8080"
    environment:
      - MCP_HTTP_PORT=8080
      - MCP_HTTP_HOST=0.0.0.0
```

Here `0.0.0.0` is the container-side bind address; the host-side port remains loopback-only. This override has no authentication and is only a temporary single-host migration path. Before adding co-located containers or exposing the service beyond the local machine, follow the hardened [deployment guidance](SECURITY.md#deployment-recommendations).

</details>

<details>
<summary>HTTP Transport</summary>

By default the server uses STDIO, launched by your MCP client. To use HTTP instead, run `mcp-searxng` as a **standalone process** with `MCP_HTTP_PORT` set. In this mode it serves the MCP protocol over HTTP and does not speak STDIO, so your client connects to it by URL rather than spawning it.

**Start the server:**

```bash
MCP_HTTP_PORT=3000 SEARXNG_URL=http://localhost:8080 mcp-searxng
```

Or with Docker (bind to all interfaces so the port is reachable from the host):

```bash
docker run --rm -p 3000:3000 \
  --add-host=host.docker.internal:host-gateway \
  -e MCP_HTTP_PORT=3000 -e MCP_HTTP_HOST=0.0.0.0 \
  -e SEARXNG_URL=http://host.docker.internal:8080 \
  isokoliuk/mcp-searxng:latest
```

The `--add-host` mapping lets the container reach a SearXNG instance on the host via `host.docker.internal`; it resolves automatically on Docker Desktop but needs this flag on native Linux. Point `SEARXNG_URL` at your actual instance if it runs elsewhere.

**Connect an HTTP-capable MCP client** to the `/mcp` endpoint by URL:

```json
{
  "mcpServers": {
    "searxng-http": {
      "type": "streamable-http",
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

**Endpoints:** `POST/GET/DELETE /mcp` (MCP protocol), `GET /health` (health check)

**Test it:**

```bash
curl http://localhost:3000/health
```

The server binds to `127.0.0.1` by default; set `MCP_HTTP_HOST=0.0.0.0` for remote or containerized deployments. Before exposing it on a network, enable hardened mode (`MCP_HTTP_HARDEN`) and see [CONFIGURATION.md](CONFIGURATION.md) for `MCP_HTTP_TRUST_PROXY` so rate limiting and logs use the correct client IP.

</details>

## Configuration

`SEARXNG_URL` is the only required variable — set it to your SearXNG instance URL (or a semicolon-separated list of interchangeable replicas). Everything else is optional.

See **[CONFIGURATION.md](CONFIGURATION.md)** for the full environment variable reference, including authentication, failover/fan-out, caching, timeouts, proxies, TLS, HTTP transport, and hardening.

## Troubleshooting

For self-hosted SearXNG configuration, direct verification, and troubleshooting,
see [Operating Self-Hosted SearXNG with mcp-searxng](docs/self-hosted-searxng.md).
If you do not control the instance, use the separate
[public SearXNG instance guide](docs/public-searxng-instances.md) instead.

If HTTPS requests fail behind a TLS-inspecting corporate proxy with certificate errors, see [TLS / Corporate CA](CONFIGURATION.md#tls--corporate-ca).

### 403 Forbidden from SearXNG

Your SearXNG instance likely has JSON format disabled. Edit `settings.yml` (usually `/etc/searxng/settings.yml`):

```yaml
search:
  formats:
    - html
    - json
```

Restart SearXNG (`docker restart searxng`) then verify:

```bash
curl 'http://localhost:8080/search?q=test&format=json'
```

You should receive a JSON response. If not, confirm the file is correctly mounted and YAML indentation is valid.

See also: [SearXNG settings docs](https://docs.searxng.org/admin/settings/settings.html) · [discussion](https://github.com/searxng/searxng/discussions/1789)

### Can't enable JSON? (HTML fallback)

If you must use a public instance you don't control and it rejects `format=json` (the 403 above), set the opt-in flag instead of editing the server:

Before enabling it, review the public operator's policy and the
[public-instance usage guide](docs/public-searxng-instances.md).

```json
{
  "SEARXNG_HTML_FALLBACK": "true"
}
```

A search that gets a `403`/`404` or a non-JSON response is then retried automatically **without** `format=json` and parsed from the regular HTML results page.

- **On success:** you get normal results (title, URL, snippet). They are marked `sourceFormat: "html"` in JSON mode, and text mode adds the line *"Note: Results parsed from SearXNG HTML fallback; metadata is limited."* Relevance scores and engine names are not available from HTML.
- **On failure:** parsing is best-effort and varies by the instance's theme/version, so some results may be missed or sparse. If the HTML page itself also fails — still blocked, rate-limited (`429`), auth (`401`), or `5xx` — the **fallback attempt's error is surfaced**, so the search never silently returns empty results. The fallback only triggers on `403`/`404`/non-JSON, never on auth or network errors.

Enabling JSON on an instance you control (above) remains the recommended setup — the fallback is a compatibility aid, not a replacement.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md)

## License

MIT — see [LICENSE](LICENSE) for details.
