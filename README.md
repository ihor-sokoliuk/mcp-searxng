# SearXNG MCP Server

An [MCP server](https://modelcontextprotocol.io/introduction) implementation that integrates the [SearXNG](https://docs.searxng.org) API, providing web search capabilities.

[![https://nodei.co/npm/mcp-searxng.png?downloads=true&downloadRank=true&stars=true](https://nodei.co/npm/mcp-searxng.png?downloads=true&downloadRank=true&stars=true)](https://www.npmjs.com/package/mcp-searxng)

[![https://badgen.net/docker/pulls/isokoliuk/mcp-searxng](https://badgen.net/docker/pulls/isokoliuk/mcp-searxng)](https://hub.docker.com/r/isokoliuk/mcp-searxng)

<a href="https://glama.ai/mcp/servers/0j7jjyt7m9"><img width="380" height="200" src="https://glama.ai/mcp/servers/0j7jjyt7m9/badge" alt="SearXNG Server MCP server" /></a>

## Features

- **Web Search**: General queries, news, articles, with pagination.
- **URL Content Reading**: Advanced content extraction with pagination, section filtering, and heading extraction.
- **Intelligent Caching**: URL content is cached with TTL (Time-To-Live) to improve performance and reduce redundant requests.
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
  - Read and convert the content from a URL to markdown with advanced content extraction options
  - Inputs:
    - `url` (string): The URL to fetch and process
    - `startChar` (number, optional): Starting character position for content extraction (default: 0)
    - `maxLength` (number, optional): Maximum number of characters to return
    - `section` (string, optional): Extract content under a specific heading (searches for heading text)
    - `paragraphRange` (string, optional): Return specific paragraph ranges (e.g., '1-5', '3', '10-')
    - `readHeadings` (boolean, optional): Return only a list of headings instead of full content

## Configuration

### Environment Variables

#### Required
- **`SEARXNG_URL`**: SearXNG instance URL (default: `http://localhost:8080`)
  - Format: `<protocol>://<hostname>[:<port>]`
  - Example: `https://search.example.com`

#### Optional
- **`AUTH_USERNAME`** / **`AUTH_PASSWORD`**: HTTP Basic Auth credentials for password-protected instances
- **`USER_AGENT`**: Custom User-Agent header (e.g., `MyBot/1.0`)
- **`HTTP_PROXY`** / **`HTTPS_PROXY`**: Proxy URLs for routing traffic
  - Format: `http://[username:password@]proxy.host:port`
- **`NO_PROXY`**: Comma-separated bypass list (e.g., `localhost,.internal,example.com`)

## Installation & Configuration

### [NPX](https://www.npmjs.com/package/mcp-searxng)

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

<details>
<summary>Full Configuration Example (All Options)</summary>

```json
{
  "mcpServers": {
    "searxng": {
      "command": "npx",
      "args": ["-y", "mcp-searxng"],
      "env": {
        "SEARXNG_URL": "YOUR_SEARXNG_INSTANCE_URL",
        "AUTH_USERNAME": "your_username",
        "AUTH_PASSWORD": "your_password",
        "USER_AGENT": "MyBot/1.0",
        "HTTP_PROXY": "http://proxy.company.com:8080",
        "HTTPS_PROXY": "http://proxy.company.com:8080",
        "NO_PROXY": "localhost,127.0.0.1,.local,.internal"
      }
    }
  }
}
```

**Note:** Mix and match environment variables as needed. All optional variables can be used independently or together.

</details>

### [NPM](https://www.npmjs.com/package/mcp-searxng)

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

<details>
<summary>Full Configuration Example (All Options)</summary>

```json
{
  "mcpServers": {
    "searxng": {
      "command": "mcp-searxng",
      "env": {
        "SEARXNG_URL": "YOUR_SEARXNG_INSTANCE_URL",
        "AUTH_USERNAME": "your_username",
        "AUTH_PASSWORD": "your_password",
        "USER_AGENT": "MyBot/1.0",
        "HTTP_PROXY": "http://proxy.company.com:8080",
        "HTTPS_PROXY": "http://proxy.company.com:8080",
        "NO_PROXY": "localhost,127.0.0.1,.local,.internal"
      }
    }
  }
}
```

</details>

### Docker

#### Using [Pre-built Image from Docker Hub](https://hub.docker.com/r/isokoliuk/mcp-searxng)

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

<details>
<summary>Full Configuration Example (All Options)</summary>

```json
{
  "mcpServers": {
    "searxng": {
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "SEARXNG_URL",
        "-e", "AUTH_USERNAME",
        "-e", "AUTH_PASSWORD",
        "-e", "USER_AGENT",
        "-e", "HTTP_PROXY",
        "-e", "HTTPS_PROXY",
        "-e", "NO_PROXY",
        "isokoliuk/mcp-searxng:latest"
      ],
      "env": {
        "SEARXNG_URL": "YOUR_SEARXNG_INSTANCE_URL",
        "AUTH_USERNAME": "your_username",
        "AUTH_PASSWORD": "your_password",
        "USER_AGENT": "MyBot/1.0",
        "HTTP_PROXY": "http://proxy.company.com:8080",
        "HTTPS_PROXY": "http://proxy.company.com:8080",
        "NO_PROXY": "localhost,127.0.0.1,.local,.internal"
      }
    }
  }
}
```

**Note:** Add only the `-e` flags and env variables you need.

</details>

#### Build Locally

```bash
docker build -t mcp-searxng:latest -f Dockerfile .
```

Use the same configuration as above, replacing `isokoliuk/mcp-searxng:latest` with `mcp-searxng:latest`.

#### Docker Compose

Create a `docker-compose.yml` file:

```yaml
services:
  mcp-searxng:
    image: isokoliuk/mcp-searxng:latest
    stdin_open: true
    environment:
      - SEARXNG_URL=YOUR_SEARXNG_INSTANCE_URL
      # Add any optional variables as needed:
      # - AUTH_USERNAME=your_username
      # - AUTH_PASSWORD=your_password
      # - USER_AGENT=MyBot/1.0
      # - HTTP_PROXY=http://proxy.company.com:8080
      # - HTTPS_PROXY=http://proxy.company.com:8080
      # - NO_PROXY=localhost,127.0.0.1,.local,.internal
```

Then configure your MCP client:

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

### HTTP Transport (Optional)

The server supports both STDIO (default) and HTTP transports. Set `MCP_HTTP_PORT` to enable HTTP mode.

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

**HTTP Endpoints:**
- **MCP Protocol**: `POST/GET/DELETE /mcp` 
- **Health Check**: `GET /health`

**Testing:**
```bash
MCP_HTTP_PORT=3000 SEARXNG_URL=http://localhost:8080 mcp-searxng
curl http://localhost:3000/health
```

## Running evals

```bash
SEARXNG_URL=YOUR_URL OPENAI_API_KEY=your-key npx mcp-eval evals.ts src/index.ts
```

## For Developers

### Contributing

We welcome contributions! Follow these guidelines:

**Coding Standards:**
- Use TypeScript with strict type safety
- Follow existing error handling patterns
- Write concise, informative error messages
- Include unit tests for new functionality
- Maintain 90%+ test coverage
- Test with MCP inspector before submitting
- Run evals to verify functionality

**Workflow:**

1. **Fork and clone:**
   ```bash
   git clone https://github.com/YOUR_USERNAME/mcp-searxng.git
   cd mcp-searxng
   git remote add upstream https://github.com/ihor-sokoliuk/mcp-searxng.git
   ```

2. **Setup:**
   ```bash
   npm install
   npm run watch  # Development mode with file watching
   ```

3. **Development:**
   ```bash
   git checkout -b feature/your-feature-name
   # Make changes in src/
   npm run build
   npm test
   npm run test:coverage
   npm run inspector
   ```

4. **Submit:**
   ```bash
   git commit -m "feat: description"
   git push origin feature/your-feature-name
   # Create PR on GitHub
   ```

### Testing

```bash
npm test                    # Run all tests
npm run test:coverage      # Generate coverage report
npm run test:watch         # Watch mode
```

**Coverage:** 100% success rate with comprehensive unit tests covering error handling, types, proxy configs, resources, and logging.

## License

This MCP server is licensed under the MIT License. This means you are free to use, modify, and distribute the software, subject to the terms and conditions of the MIT License. For more details, please see the LICENSE file in the project repository.
