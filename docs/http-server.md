# Run an HTTP server

Use HTTP when clients should connect to an independently running service.
For a client that should start its own process, use the
[STDIO recipes](client-configurations.md) instead.

You need a reachable SearXNG instance, an MCP client with Streamable HTTP
support, and Node.js 22+ or Docker on the server host. The operator sets
`SEARXNG_URL`; HTTP client configuration does not set the server environment.

## Choose authentication

| Connection | Configuration |
|---|---|
| Local HTTP evaluation on loopback | HTTP binds to `127.0.0.1` by default. Keep the service local. |
| Network service with a static bearer token | Enable `MCP_HTTP_HARDEN`, set `MCP_HTTP_AUTH_TOKEN`, and configure allowed origins/hosts. Give authorized clients the matching token. |
| Network service with OAuth login | Configure an external authorization server and `MCP_HTTP_AUTH_MODE=oauth`. Do not also set the static token. Configure TLS, origins, hosts and proxy trust for this deployment too. |

OAuth mode authenticates MCP requests independently of the hardening flag.
For exposed services, also enable hardening and configure the network controls.
OAuth support does not make every provider/client combination compatible:
the provider must issue the required signed JWT access tokens for this resource.
Login, client registration and token issuance belong to the provider.
See [OAuth requirements and discovery routing](../CONFIGURATION.md#optional-oauth-protected-resource).

SearXNG Basic Auth is a different connection: it authenticates the MCP server's
outbound requests to SearXNG. It does not authenticate MCP clients.

Every present MCP Origin is validated, including in non-hardened mode. Browser
deployments using a non-loopback Origin must set `MCP_HTTP_ALLOWED_ORIGINS`;
otherwise requests receive `403`. See the canonical
[Origin defaults and upgrade notice](../CONFIGURATION.md#origin-validation-and-upgrade-notice).

## Start the service

For a local check, set `SEARXNG_URL` in the shell first. Run either command in
its own terminal; the process stays running while clients connect.

POSIX shell:

```bash
MCP_HTTP_PORT=3000 npx -y mcp-searxng
```

PowerShell:

```powershell
$env:MCP_HTTP_PORT = '3000'
npx -y mcp-searxng
```

These commands assume the default static auth mode and no inherited HTTP
overrides. Check inherited `MCP_HTTP_*` settings if startup behaves differently.
In particular, hardening requires its companion settings. Stop the process
with the terminal's normal controls when finished. Clear `MCP_HTTP_PORT` before
reusing that environment to launch a STDIO server.

For a network service, the following Docker example assumes an HTTPS reverse
proxy on the Docker host. Export `SEARXNG_URL` and `MCP_HTTP_AUTH_TOKEN` in the
operator shell first; substitute your allowed browser origin and public Host.

```bash
docker run --rm -p 127.0.0.1:3000:3000 \
  -e SEARXNG_URL \
  -e MCP_HTTP_PORT=3000 \
  -e MCP_HTTP_HOST=0.0.0.0 \
  -e MCP_HTTP_HARDEN=true \
  -e MCP_HTTP_AUTH_TOKEN \
  -e MCP_HTTP_ALLOWED_ORIGINS=https://client.example.com \
  -e MCP_HTTP_ALLOWED_HOSTS=mcp.example.com \
  isokoliuk/mcp-searxng:latest
```

The inner bind address accepts container traffic; host publishing remains
loopback-only. Provide HTTPS at the reverse proxy and forward the expected
Host, including its port when applicable. A proxy in another container should
use a shared container network instead of the host-loopback publication.
Set `MCP_HTTP_TRUST_PROXY` for the actual trusted proxy topology, not a guessed
hop count. If trust remains unset behind a proxy, clients can share the
proxy's per-IP quota and capacity. With exactly one trusted hop and no alternate
ingress, use `MCP_HTTP_TRUST_PROXY=1`; otherwise use the appropriate trusted
subnets or hop count. See [HTTP settings](../CONFIGURATION.md#http-transport) and
[security deployment guidance](../SECURITY.md#deployment-recommendations).

For Docker on PowerShell, use the same arguments on one line or PowerShell
continuation syntax; the POSIX backslash above is not a PowerShell continuation.
Use a versioned package/image when repeatable deployments are required.

## Connect and verify

1. Check HTTP reachability from the server host:

   ```bash
   curl --fail --max-time 5 http://127.0.0.1:3000/health
   ```

   On Windows PowerShell, use `curl.exe` for these curl flags. Expect JSON with
   `status`, `server`, `version`, and `transport`. This endpoint is intentionally
   unauthenticated and does not contact SearXNG. It has its own rate limit.
2. Configure the client's full MCP URL, for example
   `https://mcp.example.com/mcp`, using the appropriate
   [client recipe](client-configurations.md). Match static token versus OAuth.
3. Reload the client connection and inspect its tool inventory. Expect the
   four [documented tools](tools.md); the client may prefix/group their names.
4. Make a simple search. Tool discovery and `/health` succeeding do not prove
   upstream search works. A repeated search may be cached.

For failures, start with [HTTP troubleshooting](troubleshooting.md#http-connection)
or [upstream search checks](troubleshooting.md#search-and-searxng).

## Sessions, limits and slow calls

Modern `2026-07-28` HTTP requests are sessionless. Retained legacy clients use
stateful sessions by default. `MCP_HTTP_STATELESS=true` extends per-request
serving to legacy POSTs when the deployment cannot preserve those sessions.
It is not necessary to enable that flag merely to serve modern clients.

Stateless mode is POST-only. Every stateless POST creates a fresh MCP server
and transport; it does not preserve cross-request sessions. A response may
still stream inside that POST. Modern traffic is always subject to the
configured stateless capacity/lifetime controls. See the complete
[transport contract](../CONFIGURATION.md#http-transport).

Rate limits, tool admission, per-request capacity and PDF worker slots protect
different resources. Their counters and caches are process-local. Coordinate
client and proxy timeouts with search/URL budgets before increasing limits.
Use [timeouts and capacity troubleshooting](troubleshooting.md#timeouts-and-capacity).

## Optional monitoring

An external check of `/health` can tell you that HTTP stopped responding; it
cannot identify a broken engine or failed search. A low-rate functional probe
can exercise search when the upstream operator permits it, but repeated probes
may hit the process cache. Log capture and interpreting errors are described in
[collect useful evidence](troubleshooting.md#collect-useful-evidence).

This server does not expose a Prometheus endpoint or an OpenTelemetry exporter.
You do not need to deploy a metrics stack to use the troubleshooting steps.
