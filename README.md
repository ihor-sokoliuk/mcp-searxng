# SearXNG MCP Server

An [MCP server](https://modelcontextprotocol.io/introduction) implementation that integrates the [SearXNG](https://docs.searxng.org) API, providing web search capabilities.

<a href="https://glama.ai/mcp/servers/0j7jjyt7m9"><img width="380" height="200" src="https://glama.ai/mcp/servers/0j7jjyt7m9/badge" alt="SearXNG Server MCP server" /></a>

[![Trust Score](https://archestra.ai/mcp-catalog/api/badge/quality/ihor-sokoliuk/mcp-searxng)](https://archestra.ai/mcp-catalog/ihor-sokoliuk__mcp-searxng)

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

### Proxy Support

The server supports HTTP and HTTPS proxies through environment variables. This is useful when running behind corporate firewalls or when you need to route traffic through a specific proxy server.

#### Proxy Environment Variables

Set one or more of these environment variables to configure proxy support:

- `HTTP_PROXY`: Proxy URL for HTTP requests
- `HTTPS_PROXY`: Proxy URL for HTTPS requests  
- `http_proxy`: Alternative lowercase version for HTTP requests
- `https_proxy`: Alternative lowercase version for HTTPS requests

#### Proxy URL Formats

The proxy URL can be in any of these formats:

```bash
# Basic proxy
export HTTP_PROXY=http://proxy.company.com:8080
export HTTPS_PROXY=http://proxy.company.com:8080

# Proxy with authentication
export HTTP_PROXY=http://username:password@proxy.company.com:8080
export HTTPS_PROXY=https://username:password@proxy.company.com:8080
```

#### Usage Examples

**With NPX:**
```json
{
  "mcpServers": {
    "searxng": {
      "command": "npx",
      "args": ["-y", "mcp-searxng"],
      "env": {
        "SEARXNG_URL": "YOUR_SEARXNG_INSTANCE_URL",
        "HTTP_PROXY": "http://proxy.company.com:8080",
        "HTTPS_PROXY": "http://proxy.company.com:8080"
      }
    }
  }
}
```

**With Docker:**
```json
{
  "mcpServers": {
    "searxng": {
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "SEARXNG_URL",
        "-e", "HTTP_PROXY",
        "-e", "HTTPS_PROXY",
        "isokoliuk/mcp-searxng:latest"
      ],
      "env": {
        "SEARXNG_URL": "YOUR_SEARXNG_INSTANCE_URL",
        "HTTP_PROXY": "http://proxy.company.com:8080",
        "HTTPS_PROXY": "http://proxy.company.com:8080"
      }
    }
  }
}
```

**Note:** If no proxy environment variables are set, the server will make direct connections as normal.

### HTTP Transport (Optional)

The server supports both STDIO (default) and HTTP transports:

#### STDIO Transport (Default)
- **Best for**: Claude Desktop and most MCP clients
- **Usage**: Automatic - no additional configuration needed

#### HTTP Transport  
- **Best for**: Web-based applications and remote MCP clients
- **Usage**: Set the `MCP_HTTP_PORT` environment variable

**HTTP Server Configuration:**

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
- **CORS**: Enabled for web clients

**Testing HTTP Server:**
```bash
# Start HTTP server
MCP_HTTP_PORT=3000 SEARXNG_URL=http://localhost:8080 mcp-searxng

# Check health
curl http://localhost:3000/health
```

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

## Running evals

The evals package loads an mcp client that then runs the src/index.ts file, so there is no need to rebuild between tests. You can see the full documentation [here](https://www.mcpevals.io/docs).

```bash
SEARXNG_URL=SEARXNG_URL OPENAI_API_KEY=your-key npx mcp-eval evals.ts src/index.ts
```

## For Developers

### Contributing to the Project

We welcome contributions! Here's how to get started:

#### 1. Fork and Clone

```bash
# Fork the repository on GitHub, then clone your fork
git clone https://github.com/YOUR_USERNAME/mcp-searxng.git
cd mcp-searxng

# Add the original repository as upstream
git remote add upstream https://github.com/ihor-sokoliuk/mcp-searxng.git
```

#### 2. Development Setup

```bash
# Install dependencies
npm install

# Start development with file watching
npm run watch

# Test the server with inspector
npm run inspector
```

#### 3. Development Workflow

1. **Create a feature branch:**
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. **Make your changes** in `src/` directory
   - Main server logic: `src/index.ts`
   - Error handling: `src/error-handler.ts`

3. **Build and test:**
   ```bash
   npm run build
   npm run inspector
   ```

4. **Run evals to ensure functionality:**
   ```bash
   SEARXNG_URL=http://localhost:8080 OPENAI_API_KEY=your-key npx mcp-eval evals.ts src/index.ts
   ```

#### 4. Submitting Changes

```bash
# Commit your changes
git add .
git commit -m "feat: description of your changes"

# Push to your fork
git push origin feature/your-feature-name

# Create a Pull Request on GitHub
```

### Version Management & Releases

#### For Maintainers: Bumping Versions

The project uses semantic versioning. Use npm's version command to bump versions properly:

```bash
# Patch release (0.6.0 → 0.6.1) - bug fixes
npm version patch

# Minor release (0.6.0 → 0.7.0) - new features
npm version minor

# Major release (0.6.0 → 1.0.0) - breaking changes
npm version major
```

The `postversion` script automatically:
- Updates the version in `src/index.ts`
- Stages the changes
- Amends the version commit

#### Creating Release Tags

After bumping the version:

```bash
# Push the version commit and tag
git push origin main --tags

# Or push everything at once
git push origin main --follow-tags
```

#### Publishing to NPM

```bash
# Build the project
npm run build

# Publish to NPM (make sure you're logged in)
npm publish
```

#### Docker Release

```bash
# Build and tag the Docker image
docker build -t isokoliuk/mcp-searxng:latest .
docker build -t isokoliuk/mcp-searxng:v$(node -p "require('./package.json').version") .

# Push to Docker Hub
docker push isokoliuk/mcp-searxng:latest
docker push isokoliuk/mcp-searxng:v$(node -p "require('./package.json').version")
```

### Project Structure

```
mcp-searxng/
├── src/
│   ├── index.ts          # Main MCP server implementation
│   └── error-handler.ts  # Error handling utilities
├── scripts/
│   └── update-version.js # Version update script
├── dist/                 # Built JavaScript files
├── Dockerfile           # Docker configuration
├── package.json         # Project configuration
└── tsconfig.json        # TypeScript configuration
```

### Coding Guidelines

- Use TypeScript for type safety
- Follow existing error handling patterns
- Keep error messages concise but informative
- Add appropriate emoji indicators for error categories
- Test changes with the MCP inspector
- Run evals before submitting PRs

## License

This MCP server is licensed under the MIT License. This means you are free to use, modify, and distribute the software, subject to the terms and conditions of the MIT License. For more details, please see the LICENSE file in the project repository.
