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

You need an existing **SearXNG instance with JSON search enabled**. This project
connects an MCP client to SearXNG; it does not install SearXNG. Use an instance
you operate or trust. Start with the [self-hosted](https://github.com/ihor-sokoliuk/mcp-searxng/blob/main/docs/self-hosted-searxng.md)
or [public-instance](https://github.com/ihor-sokoliuk/mcp-searxng/blob/main/docs/public-searxng-instances.md) guide if needed.

Choose how to connect:

| Your setup | Start here |
|---|---|
| Client starts the server locally | Install Node.js 22 or later, then use the NPX example below or your client recipe. |
| Client starts a Docker container | Use the Docker/STDIO recipe in [Installation](#installation). |
| You have an independently running HTTP service | Use your client's HTTP recipe with the full `/mcp` URL. |
| You need to operate an HTTP service | Follow the [HTTP server guide](https://github.com/ihor-sokoliuk/mcp-searxng/blob/main/docs/http-server.md). |

For clients using `mcpServers` JSON (such as Claude Desktop), add:

```json
{
  "mcpServers": {
    "searxng": {
      "command": "npx",
      "args": ["-y", "mcp-searxng"],
      "env": { "SEARXNG_URL": "https://search.example.com" }
    }
  }
}
```

Replace the example URL with your SearXNG base URL. Other clients use different
configuration shapes: choose [your client recipe](https://github.com/ihor-sokoliuk/mcp-searxng/blob/main/docs/client-configurations.md).
Leave `MCP_HTTP_PORT` unset for local STDIO. Docker also needs environment
forwarding into the container.

Reload the client, inspect its MCP tool inventory, then ask it to search for
SearXNG documentation. A simple tool call is
`searxng_web_search` with `{"query":"SearXNG"}`. Discovery alone does not
test SearXNG connectivity. If the call fails, start with
[troubleshooting](https://github.com/ihor-sokoliuk/mcp-searxng/blob/main/docs/troubleshooting.md).

## Features

- Search with pagination, filters, direct answers and full or compact text/JSON output.
- Read HTML, structured text and bounded PDF text; inspect headings or selected sections.
- Discover instance capabilities and get query suggestions.
- Optional replica failover/fan-out, HTML fallback, caching, proxies and browser solvers.
- Local STDIO or Streamable HTTP, with static bearer and optional OAuth protection.

See the [tool guide](https://github.com/ihor-sokoliuk/mcp-searxng/blob/main/docs/tools.md) for capabilities and limits,
[configuration reference](https://github.com/ihor-sokoliuk/mcp-searxng/blob/main/CONFIGURATION.md) for settings, and
[historical deployment measurements](https://github.com/ihor-sokoliuk/mcp-searxng/blob/main/docs/deployment-profiles.md) for
bounded resource-planning evidence.

## Why mcp-searxng?

<details>
<summary>Capability comparison recorded on 2026-07-29</summary>

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

</details>

Privacy depends on the SearXNG deployment. An operator-controlled instance can
avoid trusting a third-party search operator, while a public instance receives
the query and may log it. SearXNG and this MCP integration do not by themselves
provide anonymity.


## How It Works

`MCP client → mcp-searxng → SearXNG → search engines`

The client either starts its own STDIO process or connects to an HTTP service.
`SEARXNG_URL` identifies the SearXNG service, not the MCP endpoint. URL reading
fetches the selected website directly. A semicolon-separated replica list is
supported for interchangeable SearXNG deployments; see
[replica configuration](https://github.com/ihor-sokoliuk/mcp-searxng/blob/main/CONFIGURATION.md#core).

## Tools

| Tool | Use it to |
|---|---|
| `searxng_web_search` | Find sources and refine results |
| `searxng_search_suggestions` | Complete or refine a query |
| `searxng_instance_info` | Inspect categories, engines and defaults |
| `web_url_read` | Read a known URL as text/Markdown |

The [tool guide](https://github.com/ihor-sokoliuk/mcp-searxng/blob/main/docs/tools.md) contains examples and the full parameter
reference. The optional [research workflow](https://github.com/ihor-sokoliuk/mcp-searxng/blob/main/docs/research-workflow.md)
explains how to inspect sources and cite evidence.

## Installation

For NPX and npm installs, Node.js 22 or later is required. The Docker image
includes its Node.js runtime.

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

Image signatures can be verified with Cosign — see [SECURITY.md](https://github.com/ihor-sokoliuk/mcp-searxng/blob/main/SECURITY.md) for instructions.

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
For browser-solver integration, pass `FLARESOLVERR_URL`, `BYPARR_URL`, or both
and make the configured services reachable from this container. Dual mode has
a fixed FlareSolverr-first order and no automatic reverse failover. See
[URL Reader Controls](https://github.com/ihor-sokoliuk/mcp-searxng/blob/main/CONFIGURATION.md#url-reader-controls) for the complete
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

Here `0.0.0.0` is the container-side bind address; the host-side port remains loopback-only. This override has no authentication and is only a temporary single-host migration path. Before adding co-located containers or exposing the service beyond the local machine, follow the hardened [deployment guidance](https://github.com/ihor-sokoliuk/mcp-searxng/blob/main/SECURITY.md#deployment-recommendations).

</details>

### HTTP Transport

Run HTTP independently, then connect the client. See the
[HTTP server guide](https://github.com/ihor-sokoliuk/mcp-searxng/blob/main/docs/http-server.md) for local checks, static bearer
authentication, OAuth requirements and deployment verification.


## Configuration

For the default local setup, `SEARXNG_URL` is the required setting. Optional
modes such as hardened HTTP and OAuth have companion requirements. Use the
[configuration reference](https://github.com/ihor-sokoliuk/mcp-searxng/blob/main/CONFIGURATION.md) for environment variables,
defaults, caching, timeouts, proxies, TLS, and limits.

### Optional MCP OAuth

An HTTP deployment can use OAuth with an external authorization provider.
See [authentication choices](https://github.com/ihor-sokoliuk/mcp-searxng/blob/main/docs/http-server.md#choose-authentication).
Static bearer authentication and SearXNG Basic Auth protect different connections.

## Troubleshooting

| Symptom | Next check |
|---|---|
| Server absent or disconnected | [Client/process startup](https://github.com/ihor-sokoliuk/mcp-searxng/blob/main/docs/troubleshooting.md#client-and-process) |
| HTTP auth, session or proxy error | [HTTP connection](https://github.com/ihor-sokoliuk/mcp-searxng/blob/main/docs/troubleshooting.md#http-connection) |
| Tools appear but search fails | [SearXNG connection](https://github.com/ihor-sokoliuk/mcp-searxng/blob/main/docs/troubleshooting.md#search-and-searxng) |
| Empty, poor or stale results | [Filters, upstream metadata and cache](https://github.com/ihor-sokoliuk/mcp-searxng/blob/main/docs/troubleshooting.md#result-quality-and-cache) |
| URL/PDF failure or timeout | [URL reading](https://github.com/ihor-sokoliuk/mcp-searxng/blob/main/docs/troubleshooting.md#url-reading) |

### 403 Forbidden from SearXNG

JSON output may be disabled, or an access-control layer may have denied the
request. Follow the [direct checks](https://github.com/ihor-sokoliuk/mcp-searxng/blob/main/docs/self-hosted-searxng.md#verify-searxng-directly)
before changing settings. A working browser page does not prove the JSON API works.

### Can't enable JSON? (HTML fallback)

`SEARXNG_HTML_FALLBACK=true` can retry 403/404/non-JSON search responses as HTML.
Parsing is best-effort and metadata is limited; compact output omits fallback
markers. Read the [public-instance guidance](https://github.com/ihor-sokoliuk/mcp-searxng/blob/main/docs/public-searxng-instances.md#json-rejection-and-html-fallback)
before enabling it on a service you do not control.

For a bug report, [collect a minimal reproduction and relevant errors](https://github.com/ihor-sokoliuk/mcp-searxng/blob/main/docs/troubleshooting.md#collect-useful-evidence).

## Documentation

[Find a guide by task](https://github.com/ihor-sokoliuk/mcp-searxng/blob/main/docs/index.md). These links open current main-branch
documentation. Unreleased behavior is labeled; consult the matching Git tag
when investigating an older version.

## Contributing

See [CONTRIBUTING.md](https://github.com/ihor-sokoliuk/mcp-searxng/blob/main/CONTRIBUTING.md).

## License

MIT — see [LICENSE](LICENSE) for details.
