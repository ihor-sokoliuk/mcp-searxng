<div align="center">

# 🔍 SearXNG MCP Server

**Private web search for AI assistants — connect any SearXNG instance to Claude, Cursor, and more.**

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

## Features

- **Web Search**: General queries, news, articles, with pagination.
- **Instance Failover**: Configure multiple interchangeable SearXNG replicas in `SEARXNG_URL`; searches fail over by default and can optionally fan out in parallel.
- **Structured Search Output**: Choose formatted text or raw SearXNG-shaped JSON with `response_format`.
- **Direct Answers & Metadata**: Text results surface SearXNG answers, corrections, suggestions, and infoboxes before result lists.
- **Search Suggestions**: Query autocomplete via SearXNG's `/autocompleter` endpoint.
- **Instance Capability Discovery**: Inspect configured categories, engines, defaults, locales, and plugins from `/config`.
- **URL Content Reading**: Advanced content extraction with pagination, section filtering, and heading extraction.
- **Intelligent Caching**: URL content is cached with TTL (Time-To-Live) to improve performance and reduce redundant requests.
- **Pagination**: Control which page of results to retrieve.
- **Time Filtering**: Filter results by time range (day, week, month, year).
- **Language Selection**: Filter results by preferred language.
- **Safe Search**: Control content filtering level for search results.
- **Relevance Filtering**: Filter out low-scoring search results with `min_score`.

## Why mcp-searxng?

| | Brave MCP | Exa MCP | Firecrawl MCP | **mcp-searxng** |
|--|:---------:|:-------:|:-------------:|:---------------:|
| Web Search | ✓ | ✓ | ✓ | ✓ |
| Read URL | ✗ | ✓ | ✓ | ✓ |
| Pagination | ✗ | ✗ | ✓ | ✓ |
| Self-hosted | ✗ | ✗ | Partial | ✓ |
| Privacy | ✗ | ✗ | ✗ | ✓ |
| Free / No API key | ✗ | ✗ | ✗ | ✓ |

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

## Tools

- **searxng_web_search**
  - Execute web searches with pagination
  - Inputs:
    - `query` (string): The search query. This string is passed to external search services.
    - `pageno` (number, optional): Search page number, starts at 1 (default 1)
    - `time_range` (string, optional): Filter results by time range - one of: "day", "week", "month", "year" (default: none)
    - `language` (string, optional): Language code for results (e.g., "en", "fr", "de") or "all" (default: "all")
    - `safesearch` (number, optional): Safe search filter level (0: None, 1: Moderate, 2: Strict) (default: instance setting)
    - `min_score` (number, optional): Minimum relevance score from 0.0 to 1.0. Results below this score are filtered out.
    - `num_results` (number, optional): Maximum number of results to return, from 1 to 20. `SEARXNG_MAX_RESULTS` applies as an operator ceiling.
    - `categories` (string, optional): Comma-separated SearXNG categories (e.g. `"news"`, `"it,science"`). When live `/config` is available, values are trimmed and normalized case-insensitively to the instance's canonical category names; unknown values are rejected with available categories listed. If `/config` is unavailable, values are forwarded as-is with a warning. Default: SearXNG instance default.
    - `engines` (string, optional): Comma-separated SearXNG engine names (e.g. `"google,bing,ddg"`, `"semantic scholar"`). When live `/config` is available, values are trimmed and normalized case-insensitively to canonical engine names, including engines disabled by default; unknown values are rejected with available engines listed. If `/config` is unavailable, values are forwarded as-is with a warning.
    - `response_format` (string, optional): Response format, either `"text"` for formatted agent-readable output or `"json"` for raw SearXNG JSON with filtered/sliced `results`. (default: `"text"`)

- **searxng_search_suggestions**
  - Get autocomplete suggestions for refining search queries
  - Inputs:
    - `query` (string): Partial or complete query to autocomplete.
    - `language` (string, optional): Language code for suggestions (e.g., "en", "fr", "de") or "all" (default: "all")

- **searxng_instance_info**
  - Discover categories, engines, defaults, locales, and plugins exposed by the configured SearXNG instance
  - Inputs:
    - `includeEngines` (boolean, optional): Include enabled engine names in the response. (default: false)
    - `includeDisabled` (boolean, optional): Include disabled engine names when `includeEngines` is true. (default: false)
    - `category` (string, optional): Filter categories and engines to a single category name.
    - `refresh` (boolean, optional): Bypass the process cache and fetch fresh `/config` data. (default: false)

- **web_url_read**
  - Read and convert the content from a URL to markdown with advanced content extraction options
  - Inputs:
    - `url` (string): The URL to fetch and process
    - `startChar` (number, optional): Starting character position for content extraction (default: 0)
    - `maxLength` (number, optional): Maximum number of characters to return
    - `section` (string, optional): Extract content under a specific heading (searches for heading text)
    - `paragraphRange` (string, optional): Return specific paragraph ranges (e.g., '1-5', '3', '10-')
    - `readHeadings` (boolean, optional): Return only a list of headings instead of full content

## Installation

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
      - SEARXNG_URL=YOUR_SEARXNG_INSTANCE_URL
      # Add optional variables as needed — see CONFIGURATION.md
```

MCP client config:

```json
{
  "mcpServers": {
    "searxng": {
      "command": "docker-compose",
      "args": ["run", "--rm", "mcp-searxng"]
    }
  }
}
```

</details>

<details>
<summary>HTTP Transport</summary>

By default the server uses STDIO. Set `MCP_HTTP_PORT` to enable HTTP mode:

```json
{
  "mcpServers": {
    "searxng-http": {
      "command": "mcp-searxng",
      "env": {
        "SEARXNG_URL": "YOUR_SEARXNG_INSTANCE_URL",
        "MCP_HTTP_PORT": "3000"
      }
    }
  }
}
```

**Endpoints:** `POST/GET/DELETE /mcp` (MCP protocol), `GET /health` (health check)

**Test it:**

```bash
MCP_HTTP_PORT=3000 SEARXNG_URL=http://localhost:8080 mcp-searxng
curl http://localhost:3000/health
```

</details>

## Configuration

Set `SEARXNG_URL` to your SearXNG instance URL. For failover, set it to semicolon-separated interchangeable replica URLs. Set `SEARXNG_FANOUT=true` to query all healthy replicas in parallel and merge results. All other variables are optional.

Full environment variable reference: [CONFIGURATION.md](CONFIGURATION.md)

## Troubleshooting

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

```json
"SEARXNG_HTML_FALLBACK": "true"
```

A search that gets a `403`/`404` or a non-JSON response is then retried automatically **without** `format=json` and parsed from the regular HTML results page.

- **On success:** you get normal results (title, URL, snippet). They are marked `sourceFormat: "html"` in JSON mode, and text mode adds the line *"Note: Results parsed from SearXNG HTML fallback; metadata is limited."* Relevance scores and engine names are not available from HTML.
- **On failure:** parsing is best-effort and varies by the instance's theme/version, so some results may be missed or sparse. If the HTML page itself also fails — still blocked, rate-limited (`429`), auth (`401`), or `5xx` — the **original error is surfaced unchanged**. The fallback only triggers on `403`/`404`/non-JSON, never on auth or network errors.

Enabling JSON on an instance you control (above) remains the recommended setup — the fallback is a compatibility aid, not a replacement.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md)

## Star History

<a href="https://www.star-history.com/?repos=ihor-sokoliuk%2Fmcp-searxng&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=ihor-sokoliuk/mcp-searxng&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=ihor-sokoliuk/mcp-searxng&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=ihor-sokoliuk/mcp-searxng&type=date&legend=top-left" />
 </picture>
</a>

## License

MIT — see [LICENSE](LICENSE) for details.
