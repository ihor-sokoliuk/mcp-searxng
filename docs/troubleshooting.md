# Troubleshooting

Start with the symptom below. Check one layer at a time before changing settings.
Keep retries small, especially against a public SearXNG instance.

| What you see | Start here |
|---|---|
| Server absent, disconnected, or fails to start | [Client and process](#client-and-process) |
| HTTP connection, authentication, session, or proxy error | [HTTP connection](#http-connection) |
| Tools appear, but search fails | [Search and SearXNG](#search-and-searxng) |
| Empty, poor, or stale search results | [Result quality and cache](#result-quality-and-cache) |
| URL, browser solver, or PDF fails | [URL reading](#url-reading) |
| Calls time out or report busy | [Timeouts and capacity](#timeouts-and-capacity) |
| Need to report a problem | [Collect useful evidence](#collect-useful-evidence) |

## What each check proves

| Check | Success means | It does not prove |
|---|---|---|
| Client loads configuration | The entry was recognized | The server started or connected |
| Fresh MCP tool discovery | The MCP connection can list tools | SearXNG is reachable; a cached client inventory may not prove a current connection |
| HTTP `GET /health` | That HTTP handler is reachable | Authentication, tool execution, or search works |
| `searxng_instance_info` | Capability data is available, possibly cached | JSON search or every engine works |
| A search call | That query completed through the search path, possibly cached | Every engine is healthy or later calls will succeed |
| A URL read | That target was readable, possibly cached | SearXNG or other websites work |

## Client and process

Use your [client recipe](client-configurations.md) to reload the server and
inspect its connection status. The server exposes four tools; clients may
prefix, group, defer, or hide their names. Check the client's MCP inventory,
not only the model's current tool list.

For local STDIO:

1. Confirm `node --version` is 22 or later for NPX, or `docker version` can
   reach the Docker engine for Docker. Run these where the client launches
   processes. A GUI client may have a different PATH/environment than a terminal.
2. Check that the entry passes `SEARXNG_URL` to the child process. Docker also
   needs `-e SEARXNG_URL`; adding a client environment value alone does not
   forward it into a container.
3. Remove `MCP_HTTP_PORT` from a STDIO launch environment. It selects HTTP
   instead. Use `docker run -i --rm`, without `-t` or `-d`; Compose uses
   `docker compose run --rm -T`.
4. Inspect startup errors before changing search settings. Missing executable,
   invalid environment, and missing dependencies happen before a tool call.

STDIO is started by the client and waits for protocol messages; silence when
launched manually is not a health failure. Do not add diagnostic text to stdout
or combine stderr with stdout: stdout carries MCP messages. Starting another
copy to inspect it does not inspect the client's existing process or cache.

For HTTP, the client does not start the service. Follow the
[independent HTTP setup](http-server.md) and check the full `/mcp` URL.

### Container networking

`localhost` inside a container means that container. Use the SearXNG service
name on a shared Docker network, or the host address supported by your Docker
installation. Docker Desktop provides `host.docker.internal`; do not assume
that name exists on every Linux deployment. The HTTP server binds to loopback
by default; a container receiving network traffic needs `MCP_HTTP_HOST=0.0.0.0`
inside it, with appropriate host-side publishing and access controls.

On native Linux Docker, add `--add-host=host.docker.internal:host-gateway`
to `docker run` before the image name when SearXNG runs on the host. In a client
JSON recipe, add that flag as another `args` entry. The host service must listen
on an address reachable from the container; this mapping does not expose a
loopback-only listener. See Docker's [host-gateway guidance](https://docs.docker.com/reference/cli/docker/container/run#add-host).

## HTTP connection

First identify who returned the error: the MCP endpoint, a reverse proxy, the
SearXNG service, or the fetched website. A tool can return a failure inside a
successful HTTP response; do not diagnose only from the outer HTTP status.

| Observable error | Check and interpretation | Next action |
|---|---|---|
| MCP `401` | Check the configured auth mode. Static mode expects the operator's token; OAuth requires provider discovery and a valid access token for this resource. | Follow [authentication setup](http-server.md#choose-authentication). SearXNG Basic Auth does not authenticate MCP clients. |
| MCP `403` | Inspect Host/Origin errors or an OAuth scope challenge. An invalid present Origin is rejected even outside hardened mode. | Compare the actual request Host and Origin with exact allowlist entries; check OAuth scopes. Do not disable protection to guess the cause. |
| `404` with `Session not found` | A retained legacy session may have expired or reached another process. | Reconnect/reinitialize the client. Review [session handling](../CONFIGURATION.md#http-transport) if the deployment cannot keep sessions on one process. |
| HTTP `400` protocol/header mismatch, or `405` | Check client/server versions, the endpoint, and sessionless versus retained legacy mode. | Use the client's MCP transport or Inspector; a bare JSON-RPC ping is not a universal probe for all protocol versions. |
| MCP `429`, code `-32029` | An HTTP request quota was exceeded. The response's rate-limit headers describe the applicable limit. | Wait for the window to reset; inspect [HTTP rate limits](../CONFIGURATION.md#rate-limiting-http-mode) and whether a proxy collapses client identities. |
| MCP `503`, `Server busy` | Modern or legacy-stateless HTTP in-flight capacity is full. | Reduce concurrency and respect `Retry-After`; see [capacity](#timeouts-and-capacity). |
| MCP `504`, `Stateless request timed out` | The admitted request lifetime expired before response headers. After streaming begins, timeout can instead close the connection. | Compare the request lifetime with client, proxy, and tool-stage timeouts. |
| `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR` in logs | A proxy supplied forwarded identity but Express trust-proxy is not configured for that topology. This diagnostic is not itself a `429`. | Configure only the actual trusted hops/subnets; see [proxy settings](../CONFIGURATION.md#http-transport). |

For a generic `404`, check the route before assuming a lost session. For a
proxy-generated status or TLS failure, inspect that layer's logs: it may have
rejected the request before mcp-searxng received it.

## Search and SearXNG

Start with `searxng_web_search` and `{"query":"SearXNG"}`. Capture the actual
arguments: a client can inject optional values that override server defaults.

If you operate the instance, make one direct request from a network context
that follows the MCP process's DNS, authentication, proxy and TLS path. This
POSIX-shell example uses placeholders; substitute your base URL:

```bash
curl --fail-with-body --silent --show-error --max-time 15 --get \
  'https://search.example.com/search' \
  --data-urlencode 'q=SearXNG' \
  --data-urlencode 'format=json'
```

Expect a successful HTTP response and parseable JSON. Inspect its results and
engine-error metadata. Browser HTML working does not prove the JSON API works.
If the direct check succeeds, compare the MCP process's environment, filters,
credentials and caches. If it fails too, investigate SearXNG or its ingress.
See the [self-hosted checks](self-hosted-searxng.md#verify-searxng-directly).

| Upstream symptom | Interpretation and next check |
|---|---|
| `401` | Check credentials accepted by the SearXNG ingress; use [SearXNG Basic Auth](../CONFIGURATION.md#authentication). |
| `403` | JSON might be disabled, or a proxy/limiter/access-control layer denied access. Check the response and server configuration before changing `search.formats`. |
| `404` | Recheck the base URL and any path prefix. |
| `429` | Respect the instance's limit and stop rapid retries. |
| Non-JSON response | A login, challenge, proxy error, or HTML page may have replaced JSON. Enable JSON if you control SearXNG; consider the [optional HTML fallback](../README.md#cant-enable-json-html-fallback) only where appropriate. |
| TLS/certificate error | Configure the trusted CA before starting Node; see [TLS / Corporate CA](../CONFIGURATION.md#tls--corporate-ca). Do not disable certificate validation. |
| DNS, connection failure, or `5xx` | Check the hostname, network path, SearXNG service and proxy. A larger timeout cannot repair a denial or refused connection. |

If you do not operate the instance, follow the [public-instance guide](public-searxng-instances.md).
Its `/config` inventory is not proof of enabled JSON search or healthy engines.

## Result quality and cache

Remove optional category, engine, time, language, safe-search, score and count
constraints one at a time. An explicit engine combined with `time_range`
requires verified support from every configured instance; inspect
`searxng_instance_info` or omit that filter.

**Current limitation:** upstream engine failures can appear as ordinary empty
search output ([issue #262](https://github.com/ihor-sokoliuk/mcp-searxng/issues/262)).
An empty result is not proof that nothing exists or that every engine failed.
Compare the direct SearXNG JSON, including `unresponsive_engines`, when available.
This guide does not assume the proposed fix has shipped.

Use `result_detail="full"` for diagnostic metadata. Compact output deliberately
omits warnings, provenance, cache markers and HTML-fallback markers. Even full
output is not a complete engine-health assessment.

Search and URL caches live in each MCP process; see the
[search TTL](../CONFIGURATION.md#search-result-controls) and
[URL TTL](../CONFIGURATION.md#url-reader-controls) settings for defaults and overrides.
Repeated calls can therefore reflect earlier data. Full search output marks
cache hits; compact output does not. `searxng_instance_info` with `refresh=true`
refreshes capabilities, not search results. There is no per-call search-cache
refresh parameter. Inspect the configured TTL, wait for expiry, or restart only
your own MCP process through its normal controls when an intentional reset is
appropriate. A new client-launched process has a different cache.

With several replicas, compare each instance directly before assuming its
engines/settings are interchangeable. See [replica guidance](self-hosted-searxng.md).

## URL reading

Test the URL independently of search. `web_url_read` fetches the destination
website directly; it does not ask SearXNG to download it.

| Symptom | Check and next action |
|---|---|
| Private/internal URL blocked | This is the default URL-reader boundary, including redirects and direct DNS answers. Review [URL security](../CONFIGURATION.md#url-reader-security) before intentionally allowing internal reads. |
| Unsupported or oversized content | Inspect content type and the configured byte cap. Media/archive downloads are not readable documents. A HEAD check is advisory; streaming limits still apply. |
| PDF explanation instead of text | Scanned/image-only PDFs need OCR elsewhere; encrypted PDFs may not be readable. Check the page/input/text limits and `%PDF-` signature requirement in the [tool guide](tools.md#web_url_read). |
| `PDF text extraction is busy; try again later.` | Two parser slots are already occupied. Retry later with lower concurrency; this fixed parser limit is separate from HTTP or tool admission. |
| Solver reports success but page still fails | The server uses solver cookies/user-agent, then fetches the target again. It does not return rendered solver HTML; acquisition success does not prove replay access. |
| Solver unavailable or target challenge persists | Inspect acquisition versus replay errors and provider reachability. Review [solver controls](../CONFIGURATION.md#url-reader-controls); provider failover is conditional, and challenge success is not guaranteed. |

Use headings or pagination to inspect long successful content. Return limits
such as `maxLength` limit output text; they do not increase download or PDF limits.

## Timeouts and capacity

Compare the budgets at the layer that failed:

- Client startup/catalog/tool-call timeout: the client can stop waiting before
  the server's work budget expires. Find the setting in that client's docs.
- Search: `SEARXNG_TIMEOUT_MS` applies per attempt. Replica attempts and HTML
  fallback can add time; capability and suggestion calls use separate limits.
- URL reader: network fetch, optional solver acquisition and PDF parsing have
  separate budgets. See [URL Reader Controls](../CONFIGURATION.md#url-reader-controls).
- HTTP: proxies and modern/legacy-stateless request lifetimes can stop an
  otherwise valid tool operation.
- Tool admission: an MCP tool error about busy/rate-limited work is separate
  from HTTP status limits and PDF slots. See [tool admission](../CONFIGURATION.md#tool-invocation-admission-all-transports).

Reduce concurrency before raising limits. Increase a timeout only when the
operation is expected to take longer and the surrounding layers permit it.
Cancellation depends on propagation; a remote browser can keep working until
its own provider timeout after the MCP caller disconnects.

## Collect useful evidence

Use the [client status/error entry points](client-configurations.md#find-client-errors)
first. There are two different logging paths:

- **Process diagnostics:** startup/configuration failures and process errors.
  The parent client captures local STDIO stderr; a running HTTP container's
  process output is available through `docker logs CONTAINER_NAME`.
- **MCP call events:** retained legacy logging notifications or modern
  request-scoped logs. Visibility and level controls depend on the client.
  Process stderr/container logs do not necessarily include these events.

There is no mcp-searxng `LOG_LEVEL` environment setting. A silent log view does
not establish that a call succeeded. Where supported, the
`config://server-config` resource gives a limited, redacted configuration
snapshot and package version; it is not a complete effective configuration or
metrics history. `help://usage-guide` contains built-in usage help.

For a [bug report](https://github.com/ihor-sokoliuk/mcp-searxng/issues/new?template=bug_report.yml), collect:

1. Actual running package version, client/version, OS, transport, and install
   method. For a pinned npm install, `mcp-searxng --version` reports that binary;
   an unpinned fresh NPX invocation may differ from the client's running version.
2. One minimal tool call and its result/error, whether it was the first or a
   repeated call, and the failure time with timezone.
3. Relevant configuration fields and a short excerpt of the matching startup
   error or MCP event. Include direct upstream status/metadata only if available.
4. What you expected, which check succeeded/failed, and what changed recently.

Prefer a synthetic query over confidential real searches. Redact tokens,
passwords, cookies, signed URL parameters, private query/result content and
sensitive internal addresses. Preserve error codes, parameter names and response
structure. Do not post full environment dumps or entire debug logs. If logs are
unavailable, say which client view you checked; that is useful evidence too.
