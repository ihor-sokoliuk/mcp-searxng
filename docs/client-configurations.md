# MCP Client Configuration Cookbook

This guide connects supported MCP clients to an already selected SearXNG
endpoint through `mcp-searxng`. It does not discover or install SearXNG, bundle
SearXNG with this server, or install `mcp-searxng` as a client plugin.

Choose one connection mode:

- **NPX/STDIO:** the client starts the npm package locally. Requires Node.js 22 or later.
- **Docker/STDIO:** the client starts the published container locally. Requires
  Docker.
- **HTTP:** the client connects to an independently running Streamable HTTP
  server. The server operator, not the client configuration, sets
  `SEARXNG_URL`.

<a id="verified-support-matrix"></a>

## Recipe coverage

These recipes were checked against the linked client documentation on
2026-09-13. A recipe being included means its configuration is documented by the
client; it does not mean every client/version/OS combination was exercised with
this server. “Not provided” means this guide has no recipe for that combination.

| Client | NPX/STDIO | Docker/STDIO | HTTP |
| --- | --- | --- | --- |
| Claude Desktop | Yes | Yes | Not provided |
| Claude Code | Yes | Yes | Yes |
| Codex CLI | Yes | Yes | Yes |
| Cursor | Yes | Yes | Not provided |
| VS Code | Yes | Yes | Yes |
| Windsurf | Yes | Yes | Yes |
| Cline | Yes | Yes | Yes |
| OpenCode | Yes | Yes | Yes |

HTTP deployments support either a static bearer token or optional
[OAuth through an external authorization server](../CONFIGURATION.md#optional-oauth-protected-resource).
OAuth support is included in mcp-searxng 2.2.0. Client login, registration and
token issuance require a compatible provider; this server only protects the
resource. Claude Desktop and Cursor remote recipes remain untested here.
Cursor also documents custom bearer headers; the absence of a recipe is not a
claim that those clients cannot connect remotely.

## Choose your client

[Claude Desktop](#claude-desktop) · [Claude Code](#claude-code) ·
[Codex CLI](#codex-cli) · [Cursor](#cursor) · [VS Code](#vs-code) ·
[Windsurf](#windsurf) · [Cline](#cline) · [OpenCode](#opencode)

Each recipe gives a configuration location and example. After configuring it,
use the [client-specific check](#find-client-errors), then
[verify a useful call](#verify-the-connection). For an existing setup that is
failing, start with [troubleshooting](troubleshooting.md).

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
Connectors UI rather than `claude_desktop_config.json`. For a protected remote
server, review the OAuth provider requirements above; an end-to-end Claude
Desktop login flow has not been verified here. See Anthropic's
[local MCP](https://support.anthropic.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop)
and [remote connector](https://support.anthropic.com/en/articles/11503834-building-custom-connectors-via-remote-mcp-servers)
documentation.

### Cursor

Put one shared local entry in `.cursor/mcp.json` for a project or
`~/.cursor/mcp.json` for all projects. Cursor documents STDIO plus remote
OAuth and custom HTTP headers; this guide provides local recipes, while remote
client/provider combinations have not been exercised here. See the
[Cursor MCP documentation](https://cursor.com/docs/mcp).

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

OpenCode V2 stores servers under `mcp.servers` in `opencode.json`. Keep either
the `searxng` NPX entry or the `searxng-docker` entry and remove the one you do
not use.

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

Run `opencode mcp list` for the V2 CLI. See the
[OpenCode V2 MCP documentation](https://opencode.ai/v2/docs/mcp-servers).

## Start an HTTP server first

HTTP client entries do not start the service. The operator should follow
[HTTP server setup](http-server.md), including TLS and the chosen auth mode,
before sharing the full endpoint URL. In static mode, the client's
`MCP_SEARXNG_TOKEN` must match the server's `MCP_HTTP_AUTH_TOKEN`.
The server's `MCP_HTTP_ALLOWED_ORIGINS`, `MCP_HTTP_ALLOWED_HOSTS` and
trusted proxy settings depend on its deployment, not this client's environment.

For OAuth, follow the client/provider login flow instead of copying a static
token. See [OAuth requirements](../CONFIGURATION.md#optional-oauth-protected-resource).
The static-header recipes above are intentionally separate from OAuth login.

## Verify the connection

After saving the client configuration:

1. Restart or reload the MCP server in the client.
2. Inspect the server inventory for these four tools; clients may prefix, group,
   defer or hide them from the model:
   - `searxng_web_search`
   - `searxng_search_suggestions`
   - `searxng_instance_info`
   - `web_url_read`
3. If capabilities matter, call `searxng_instance_info`. Use `refresh=true`
   when you need a fresh capability check. An unavailable `/config` does not
   necessarily mean search is unavailable.
4. Call `searxng_web_search` with `{"query":"SearXNG"}`.

If the server does not appear, inspect the client's MCP log first. For STDIO,
the most common causes are a missing executable, a Docker TTY/detached flag, or
an absent `SEARXNG_URL`. For HTTP, verify the full `/mcp` URL and TLS. In static mode, the client token
must match `MCP_HTTP_AUTH_TOKEN`; in OAuth mode, check discovery and your
authorization provider instead. Tool discovery does not contact SearXNG. A
capability response can be cached and does not prove that search works; use the
search call to check the search path.

## Find client errors

These entry points were checked against the linked primary documentation on
2026-09-13. They identify where to begin; they are not claims that every
version exposes all MCP log levels. After reconnecting, expect a connected
server/inventory, then verify an actual search.

| Client | Reload/check and inspect errors |
|---|---|
| Claude Desktop | Restart after changing the local configuration. Use Settings → Developer and the server's status/log controls; see [local MCP troubleshooting](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop). |
| Claude Code | Use `claude mcp get searxng`, then `/mcp` and the server menu to inspect status or reconnect. A cached discovery entry may connect only on first use; see [server status](https://code.claude.com/docs/en/mcp#server-status-detail). |
| Codex CLI | Run `codex mcp list` and `codex mcp get searxng`; inspect the client's startup/tool failure output. Configuration listing alone does not prove connectivity. See the [Codex MCP reference](https://developers.openai.com/codex/mcp). |
| Cursor | Reload/toggle the server in Customize; open Output and select MCP Logs. See [Cursor debugging](https://cursor.com/docs/mcp#faq). |
| VS Code | Run MCP: List Servers, select the server, and use restart or show output. See the [command reference](https://code.visualstudio.com/docs/agents/reference/mcp-configuration). |
| Windsurf | Reload the server in Cascade's MCP settings and inspect its displayed connection/tool errors; see [MCP configuration](https://docs.devin.ai/desktop/cascade/mcp). This guide does not assume a stable per-call log-file path. |
| Cline | Inspect the server in MCP Servers; the CLI's `cline mcp` wizard manages entries and `cline config mcp --json` shows configuration. See [Cline MCP](https://docs.cline.bot/mcp/mcp-overview). |
| OpenCode | Use `opencode mcp list` and `/mcps` to inspect, reconnect or authenticate. Check the tool failure in the session; see [OpenCode management](https://opencode.ai/v2/docs/mcp-servers#management). |

Replace `searxng` with the configured entry name. Use the
[evidence checklist](troubleshooting.md#collect-useful-evidence) before reporting
a problem. It distinguishes process diagnostics from MCP call events.

### Hermes diagnostic note

For an existing Hermes entry, run `hermes mcp test searxng` and inspect
`~/.hermes/logs/mcp-stderr.log` and `~/.hermes/logs/errors.log`.
These checks were used in [issue #74](https://github.com/ihor-sokoliuk/mcp-searxng/issues/74);
this is diagnostic guidance from that report, not an additional end-to-end
compatibility claim. For HTTP failures, check the full `/mcp` endpoint,
server bind address and [container networking](troubleshooting.md#container-networking).
