# SearXNG MCP Server

An [MCP server](https://modelcontextprotocol.io/introduction) that integrates the [SearXNG](https://docs.searxng.org) API, giving AI assistants web search capabilities.

[![https://nodei.co/npm/mcp-searxng.png?downloads=true&downloadRank=true&stars=true](https://nodei.co/npm/mcp-searxng.png?downloads=true&downloadRank=true&stars=true)](https://www.npmjs.com/package/mcp-searxng)

[![https://badgen.net/docker/pulls/isokoliuk/mcp-searxng](https://badgen.net/docker/pulls/isokoliuk/mcp-searxng)](https://hub.docker.com/r/isokoliuk/mcp-searxng)

<a href="https://glama.ai/mcp/servers/0j7jjyt7m9"><img width="380" height="200" src="https://glama.ai/mcp/servers/0j7jjyt7m9/badge" alt="SearXNG Server MCP server" /></a>

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

Replace `YOUR_SEARXNG_INSTANCE_URL` with the URL of your SearXNG instance (e.g. `https://search.example.com`).

## How It Works

`mcp-searxng` is a standalone MCP server — a separate Node.js process that your AI assistant connects to for web search. It queries any SearXNG instance via its HTTP JSON API.

> **Not a SearXNG plugin:** This project cannot be installed as a native SearXNG plugin. Point it at any existing SearXNG instance by setting `SEARXNG_URL`.

```
AI Assistant (e.g. Claude)
        │  MCP protocol
        ▼
  mcp-searxng  (this project — Node.js process)
        │  HTTP JSON API  (SEARXNG_URL)
        ▼
  SearXNG instance
```

## Tools

| Tool | Description | Inputs |
|---|---|---|
| `searxng_web_search` | Execute web searches with pagination | `query` (required), `pageno`, `time_range` (`day`/`month`/`year`), `language`, `safesearch` (0/1/2) |
| `web_url_read` | Fetch a URL and return its content as markdown | `url` (required), `startChar`, `maxLength`, `section`, `paragraphRange` (e.g. `1-5`), `readHeadings` |

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

<details>
<summary>Hardened HTTP Mode</summary>

If you expose the HTTP transport on a network, enable hardened mode for authentication, CORS, and SSRF protection. Default behavior is unchanged — opt in explicitly:

```bash
MCP_HTTP_PORT=3000 \
MCP_HTTP_HARDEN=true \
MCP_HTTP_AUTH_TOKEN=replace-me \
MCP_HTTP_ALLOWED_ORIGINS=https://app.example.com \
SEARXNG_URL=http://localhost:8080 \
mcp-searxng
```

| Variable | Description |
|---|---|
| `MCP_HTTP_HARDEN` | Enable hardened mode |
| `MCP_HTTP_AUTH_TOKEN` | Required bearer token for all requests |
| `MCP_HTTP_ALLOWED_ORIGINS` | Comma-separated CORS origin allowlist |
| `MCP_HTTP_ALLOWED_HOSTS` | DNS rebinding protection allowlist override |
| `MCP_HTTP_ALLOW_PRIVATE_URLS` | Allow internal URL reads (default: blocked) |
| `MCP_HTTP_EXPOSE_FULL_CONFIG` | Expose full config in `/health` (for debugging) |

Full reference: [CONFIGURATION.md#hardened-http-mode](CONFIGURATION.md#hardened-http-mode)

</details>

## Configuration

Set `SEARXNG_URL` to your SearXNG instance URL. All other variables are optional.

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

## Running Evals

```bash
SEARXNG_URL=YOUR_URL OPENAI_API_KEY=your-key npx mcp-eval evals.ts src/index.ts
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md)

## License

MIT — see [LICENSE](LICENSE) for details.
