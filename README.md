# SearXNG MCP Server

An [MCP server](https://modelcontextprotocol.io/introduction) implementation that integrates the [SearXNG](https://docs.searxng.org) API, providing web search capabilities.

<a href="https://glama.ai/mcp/servers/0j7jjyt7m9"><img width="380" height="200" src="https://glama.ai/mcp/servers/0j7jjyt7m9/badge" alt="SearXNG Server MCP server" /></a>

[![smithery badge](https://smithery.ai/badge/@ihor-sokoliuk/server-searxng)](https://smithery.ai/server/@ihor-sokoliuk/server-searxng)

## Features

- **Web Search**: General queries, news, articles, with pagination.
- **Pagination**: Control which page of results to retrieve.
- **Time Filtering**: Filter results by time range (day, month, year).
- **Language Selection**: Filter results by preferred language.
- **Safe Search**: Control content filtering level for search results.

## Tools

- **searxng_web_search**
  - Execute web searches with pagination
  - Inputs:
    - `query` (string): The search query. This string is passed to external search services.
    - `pageno` (number, optional): Search page number, starts at 1 (default 1)
    - `time_range` (string, optional): Filter results by time range - one of: "day", "month", "year" (default: none)
    - `language` (string, optional): Language code for results (e.g., "en", "fr", "de") or "all" (default: "all")
    - `safesearch` (number, optional): Safe search filter level (0: None, 1: Moderate, 2: Strict) (default: instance setting)

- **web_url_read**
  - Read and convert the content from a URL to markdown
  - Inputs:
    - `url` (string): The URL to fetch and process

## Configuration

### Setting the SEARXNG_URL

1. Choose a SearxNG instance from the [list of public instances](https://searx.space/) or use your local environment.
2. Set the `SEARXNG_URL` environment variable to the instance URL.
3. The default `SEARXNG_URL` value is `http://localhost:8080`.

### Using Authentication

If you are using a password protected SearxNG instance you can set a username and password for HTTP Basic Auth:

- Set the `AUTH_USERNAME` environmental variable to your username
- Set the `AUTH_PASSWORD` environmental variable to your password

### Usage with Claude Desktop

### Installing via Smithery

To install SearxNG Server for Claude Desktop automatically via [Smithery](https://smithery.ai/server/@ihor-sokoliuk/server-searxng):

```bash
npx -y @smithery/cli install @ihor-sokoliuk/server-searxng --client claude
```

### [NPX](https://www.npmjs.com/package/mcp-searxng)

```json
{
  "mcpServers": {
    "searxng": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-searxng"
      ],
      "env": {
        "SEARXNG_URL": "YOUR_SEARXNG_INSTANCE_URL"
      }
    }
  }
}
```

### [NPM](https://www.npmjs.com/package/mcp-searxng)

```bash
npm install -g mcp-searxng
```

And then in your MCP config file:

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

### Docker

#### Using [Pre-built Image from Docker Hub](https://hub.docker.com/r/isokoliuk/mcp-searxng)

```bash
docker pull isokoliuk/mcp-searxng:latest
```

Add this to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "searxng": {
      "command": "docker",
      "args": [
        "run",
        "-i",
        "--rm",
        "-e",
        "SEARXNG_URL",
        "isokoliuk/mcp-searxng:latest"
      ],
      "env": {
        "SEARXNG_URL": "YOUR_SEARXNG_INSTANCE_URL"
      }
    }
  }
}
```

#### Build Locally

```bash
docker build -t mcp-searxng:latest -f Dockerfile .
```

#### Use

Add this to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "searxng": {
      "command": "docker",
      "args": [
        "run",
        "-i",
        "--rm",
        "-e",
        "SEARXNG_URL",
        "mcp-searxng:latest"
      ],
      "env": {
        "SEARXNG_URL": "YOUR_SEARXNG_INSTANCE_URL"
      }
    }
  }
}
```


## License

This MCP server is licensed under the MIT License. This means you are free to use, modify, and distribute the software, subject to the terms and conditions of the MIT License. For more details, please see the LICENSE file in the project repository.
