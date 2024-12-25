# SearxNG MCP Server

An [MCP server](https://modelcontextprotocol.io/introduction) implementation that integrates the SearxNG API, providing web search capabilities.

<a href="https://glama.ai/mcp/servers/0j7jjyt7m9"><img width="380" height="200" src="https://glama.ai/mcp/servers/0j7jjyt7m9/badge" alt="SearXNG Server MCP server" /></a>

## Features

- **Web Search**: General queries, news, articles, with pagination.
- **Pagination**: Control return size and result counts options.

## Tools

- **searxng_web_search**
  - Execute web searches with pagination
  - Inputs:
    - `query` (string): Search terms
    - `count` (number, optional): Results per page (default 20)
    - `offset` (number, optional): Pagination offset (default 0)

## Configuration

### Setting the SEARXNG_URL

1. Choose a SearxNG instance from the [list of public instances](https://searx.space/) or use your local environment.
2. Set the `SEARXNG_URL` environment variable to the instance URL.
3. The default `SEARXNG_URL` value is `http://localhost:8080`.

### Usage with Claude Desktop

### NPX

```json
{
  "mcpServers": {
    "searxng": {
      "command": "npx",
      "args": [
        "-y"
        "<full path to mcp-searxng repo>/"
      ],
      "env": {
        "SEARXNG_URL": "YOUR_SEARXNG_INSTANCE_URL"
      }
    }
  }
}
```

### Docker

#### Build

```bash
docker build -t mcp-server-searxng:latest -f Dockerfile .
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
        "mcp-server-searxng:latest"
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
