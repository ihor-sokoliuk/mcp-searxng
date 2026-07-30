# MCP Client Configuration Cookbook

This guide connects supported MCP clients to an already selected SearXNG
endpoint through `mcp-searxng`. It does not discover or install SearXNG, bundle
SearXNG with this server, or install `mcp-searxng` as a client plugin.

Choose one connection mode:

- **NPX/STDIO:** the client starts the npm package locally. Requires Node.js 20
  or newer.
- **Docker/STDIO:** the client starts the published container locally. Requires
  Docker.
- **HTTP:** the client connects to an independently running Streamable HTTP
  server. The server operator, not the client configuration, sets
  `SEARXNG_URL`.

## Verified support matrix

The matrix reflects the current authoritative client schemas linked below. A
`No` means this cookbook deliberately omits that combination; it does not claim
that the client can never support it.

| Client | NPX/STDIO | Docker/STDIO | HTTP |
| --- | --- | --- | --- |
| Claude Desktop | Yes | Yes | No |
| Claude Code | Yes | Yes | Yes |
| Codex CLI | Yes | Yes | Yes |
| Cursor | Yes | Yes | No |
| VS Code | Yes | Yes | Yes |
| Windsurf | Yes | Yes | Yes |
| Cline | Yes | Yes | Yes |
| OpenCode | Yes | Yes | Yes |

Claude Desktop remote connectors accept authless or OAuth servers, but a
network-exposed `mcp-searxng` server uses its own static bearer-token hardening.
Cursor's current remote MCP documentation likewise specifies OAuth. Because
`mcp-searxng` does not implement MCP OAuth, this cookbook keeps both clients on
local STDIO instead of recommending a weaker remote deployment.

## Values used below

Replace these placeholders:

- `https://search.example.com` — your SearXNG base URL. For local STDIO
  examples, the MCP client passes it as `SEARXNG_URL`.
- `https://mcp.example.com/mcp` — the complete MCP HTTP endpoint, including
  `/mcp`.
- `MCP_SEARXNG_TOKEN` — a client-side environment variable containing the same
  secret that the HTTP server uses as `MCP_HTTP_AUTH_TOKEN`.

For multiple interchangeable SearXNG replicas, set `SEARXNG_URL` to a
semicolon-separated list. See [Configuration](../CONFIGURATION.md) before
adding authentication, fan-out, proxies, or TLS settings.

## Shared local JSON configuration

The local server objects below work in Claude Desktop, Cursor, Windsurf, and
Cline because all four use a top-level `mcpServers` object. Keep either the NPX
entry or the Docker entry.

```json
{
  "mcpServers": {
    "searxng": {
      "command": "npx",
      "args": ["-y", "mcp-searxng"],
      "env": {
        "SEARXNG_URL": "https://search.example.com"
      }
    },
    "searxng-docker": {
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "SEARXNG_URL",
        "isokoliuk/mcp-searxng:latest"
      ],
      "env": {
        "SEARXNG_URL": "https://search.example.com"
      }
    }
  }
}
```

Do not add Docker's detached (`-d`) or TTY (`-t`) flags. The MCP client needs
the container's raw standard input and output.

### Claude Desktop

Open **Settings → Developer → Edit Config**, add one shared local entry, save,
and restart Claude Desktop. Remote servers are added through Claude's
Connectors UI rather than `claude_desktop_config.json`; no compatible hardened
HTTP recipe is claimed here. See Anthropic's
[local MCP](https://support.anthropic.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop)
and [remote connector](https://support.anthropic.com/en/articles/11503834-building-custom-connectors-via-remote-mcp-servers)
documentation.

### Cursor

Put one shared local entry in `.cursor/mcp.json` for a project or
`~/.cursor/mcp.json` for all projects. Cursor documents STDIO plus remote
OAuth; this guide uses STDIO because the server's hardened HTTP mode is static
bearer authentication. See the
[Cursor MCP documentation](https://docs.cursor.com/context/model-context-protocol).

### Windsurf

Put one shared local entry in `~/.codeium/windsurf/mcp_config.json`. For HTTP,
use the separate Windsurf recipe below. See the
[Windsurf MCP documentation](https://docs.windsurf.com/windsurf/cascade/mcp).

### Cline

For Cline CLI, put one shared local entry in `~/.cline/mcp.json`. In the IDE,
open **MCP Servers → Configure → Configure MCP Servers** and add it to the
opened `mcpServers` object. See the
[Cline MCP documentation](https://docs.cline.bot/mcp/mcp-overview).

## Claude Code

Claude Code supports STDIO commands and Streamable HTTP through `claude mcp`.
These commands use user scope; change it if you want project-local
configuration.

NPX/STDIO:

```bash
claude mcp add --scope user --env SEARXNG_URL=https://search.example.com --transport stdio searxng -- npx -y mcp-searxng
```

Docker/STDIO:

```bash
claude mcp add --scope user --env SEARXNG_URL=https://search.example.com --transport stdio searxng-docker -- docker run -i --rm -e SEARXNG_URL isokoliuk/mcp-searxng:latest
```

HTTP on POSIX shells:

```bash
claude mcp add --scope user --transport http searxng-http https://mcp.example.com/mcp --header "Authorization: Bearer ${MCP_SEARXNG_TOKEN}"
```

HTTP in PowerShell:

```powershell
claude mcp add --scope user --transport http searxng-http https://mcp.example.com/mcp --header "Authorization: Bearer $env:MCP_SEARXNG_TOKEN"
```

The shell expands the token before Claude Code stores the configuration.
Protect the resulting user configuration file. Run `claude mcp get searxng`
or `claude mcp get searxng-http`, then `/mcp` inside Claude Code to check the
connection. See the
[Claude Code MCP documentation](https://code.claude.com/docs/en/mcp).

## Codex CLI

Add one local table or the HTTP table to `~/.codex/config.toml` (on Windows,
`%USERPROFILE%\.codex\config.toml`). The TOML shape is the same on every
platform.

NPX/STDIO:

```toml
[mcp_servers.searxng]
command = "npx"
args = ["-y", "mcp-searxng"]

[mcp_servers.searxng.env]
SEARXNG_URL = "https://search.example.com"
```

Docker/STDIO:

```toml
[mcp_servers.searxng_docker]
command = "docker"
args = ["run", "-i", "--rm", "-e", "SEARXNG_URL", "isokoliuk/mcp-searxng:latest"]

[mcp_servers.searxng_docker.env]
SEARXNG_URL = "https://search.example.com"
```

HTTP:

```toml
[mcp_servers.searxng_http]
url = "https://mcp.example.com/mcp"
bearer_token_env_var = "MCP_SEARXNG_TOKEN"
```

Codex reads the bearer token from the named environment variable instead of
the TOML file. Run `codex mcp list` to inspect the configured servers. See the
[Codex MCP documentation](https://developers.openai.com/codex/mcp).

## VS Code

Put the configuration in `.vscode/mcp.json` for a workspace, or run
**MCP: Open User Configuration** for a user-level file. Keep either local
entry.

```json
{
  "servers": {
    "searxng": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "mcp-searxng"],
      "env": {
        "SEARXNG_URL": "https://search.example.com"
      }
    },
    "searxng-docker": {
      "type": "stdio",
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "SEARXNG_URL",
        "isokoliuk/mcp-searxng:latest"
      ],
      "env": {
        "SEARXNG_URL": "https://search.example.com"
      }
    }
  }
}
```

For hardened HTTP, use a password input so the token is not committed:

```json
{
  "inputs": [
    {
      "id": "searxng-token",
      "type": "promptString",
      "description": "mcp-searxng bearer token",
      "password": true
    }
  ],
  "servers": {
    "searxng-http": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${input:searxng-token}"
      }
    }
  }
}
```

Run **MCP: List Servers** to start or inspect the server. See the
[VS Code MCP configuration reference](https://code.visualstudio.com/docs/agents/reference/mcp-configuration).

## Windsurf HTTP

Windsurf interpolates environment variables in `serverUrl` and `headers`.
Export `MCP_SEARXNG_TOKEN` before launching Windsurf:

```json
{
  "mcpServers": {
    "searxng-http": {
      "serverUrl": "https://mcp.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${env:MCP_SEARXNG_TOKEN}"
      }
    }
  }
}
```

Open Cascade's MCP settings to reload the server and inspect its tools.

## Cline HTTP

Cline supports Streamable HTTP through `type: "streamableHttp"`. Its current
manual example uses a literal header value, so replace the placeholder locally
and protect the configuration file; do not commit it.

```json
{
  "mcpServers": {
    "searxng-http": {
      "type": "streamableHttp",
      "url": "https://mcp.example.com/mcp",
      "headers": {
        "Authorization": "Bearer REPLACE_WITH_TOKEN"
      },
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

The empty `autoApprove` list keeps tool calls subject to normal approval.

## OpenCode

OpenCode V2 stores servers under `mcp.servers` in `opencode.json`. Keep one
local entry.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "searxng": {
        "type": "local",
        "command": ["npx", "-y", "mcp-searxng"],
        "environment": {
          "SEARXNG_URL": "https://search.example.com"
        }
      },
      "searxng-docker": {
        "type": "local",
        "command": [
          "docker",
          "run", "-i", "--rm",
          "-e", "SEARXNG_URL",
          "isokoliuk/mcp-searxng:latest"
        ],
        "environment": {
          "SEARXNG_URL": "https://search.example.com"
        }
      }
    }
  }
}
```

For hardened HTTP, disable OAuth and read the static token from the environment:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "searxng-http": {
        "type": "remote",
        "url": "https://mcp.example.com/mcp",
        "oauth": false,
        "headers": {
          "Authorization": "Bearer {env:MCP_SEARXNG_TOKEN}"
        }
      }
    }
  }
}
```

Run `opencode2 mcp list` for the V2 CLI. See the
[OpenCode V2 MCP documentation](https://opencode.ai/v2/docs/mcp-servers).

## Start an HTTP server first

HTTP client entries do not start `mcp-searxng`. Deploy it separately and use
TLS before connecting across a network. A Docker example is:

```bash
docker run --rm -p 3000:3000 \
  -e MCP_HTTP_PORT=3000 \
  -e MCP_HTTP_HOST=0.0.0.0 \
  -e MCP_HTTP_HARDEN=true \
  -e MCP_HTTP_AUTH_TOKEN \
  -e MCP_HTTP_ALLOWED_ORIGINS=https://client.example.com \
  -e MCP_HTTP_ALLOWED_HOSTS=mcp.example.com \
  -e SEARXNG_URL \
  isokoliuk/mcp-searxng:latest
```

Set `MCP_HTTP_AUTH_TOKEN`, `MCP_SEARXNG_TOKEN`, and `SEARXNG_URL` in the
operator environment before starting the container. Replace
`https://client.example.com` with any browser client origin you intentionally
allow and `mcp.example.com` with the exact `Host` header forwarded by the
reverse proxy. Native clients that omit `Origin` are not granted browser CORS
access by this list. For reverse proxies, allowed hosts, origins, and rate-limit
behavior, follow
[Hardened HTTP Mode](../CONFIGURATION.md#hardened-http-mode) and the
[security deployment recommendations](../SECURITY.md#deployment-recommendations).

## Verify the connection

After saving the client configuration:

1. Restart or reload the MCP server in the client.
2. Confirm exactly these four tools are visible:
   - `searxng_web_search`
   - `searxng_search_suggestions`
   - `searxng_instance_info`
   - `web_url_read`
3. Call `searxng_instance_info` to confirm the selected SearXNG endpoint is
   reachable.
4. Call `searxng_web_search` with `{"query":"SearXNG"}`.

If the server does not appear, inspect the client's MCP log first. For STDIO,
the most common causes are a missing executable, a Docker TTY/detached flag, or
an absent `SEARXNG_URL`. For HTTP, verify the full `/mcp` URL, TLS, and that the
client token matches `MCP_HTTP_AUTH_TOKEN`.
