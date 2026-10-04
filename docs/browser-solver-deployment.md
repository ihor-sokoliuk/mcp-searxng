# Deploy SearXNG, MCP and optional browser solvers

Use the [search configuration guide](search-configuration.md) to choose engines
and preserve result metadata. This recipe starts a separate private stack from
an MCP source checkout. It provides four modes: no solver, FlareSolverr, Byparr,
or ordered dual-provider failover. The [dated verification](search-configuration-verification.md)
identifies the exact tested versions, failures and limits.

## Start a private stack

The files are in [examples/search-stack](examples/search-stack/compose.yml).
The base Compose file builds this checkout's MCP Dockerfile. SearXNG, Valkey and
solver images use immutable manifest digests. The sample resources were
exercised with paced single-client traffic on Linux amd64; they are not a
production concurrency benchmark.

From the repository root, open `docs/examples/search-stack`. Create a private
`.env` with a unique SearXNG secret; on a Linux host with OpenSSL:

```bash
cd docs/examples/search-stack
umask 077
printf 'SEARXNG_SECRET=%s\n' "$(openssl rand -hex 32)" > .env
docker compose -f compose.yml config --quiet
docker compose -f compose.yml up -d --build --wait
```

Keep `.env` out of version control and logs. `docker compose config` without
`--quiet` expands secrets, so use disposable values for shared configuration
reports. `SEARXNG_SECRET` is SearXNG's cryptographic secret, not MCP or HTTP
authentication. The template requires a value and the upstream container
consumes it. Preserve `settings/`; the SearXNG entrypoint may adjust its ownership.

| Mode | Start command from the example directory |
|---|---|
| No solver | `docker compose -f compose.yml up -d --build --wait` |
| FlareSolverr | `docker compose -f compose.yml -f flare.yml up -d --build --wait` |
| Byparr | `docker compose -f compose.yml -f byparr.yml up -d --build --wait` |
| Dual | `docker compose -f compose.yml -f flare.yml -f byparr.yml up -d --build --wait` |

Keep the same file list for `ps`, `logs`, `exec`, upgrades and `down`. To switch
back to no solver, recreate MCP with only the base file and stop/remove solver
services using the previous full file list. Merely removing an overlay does not
stop an already-running solver container.

SearXNG binds to host `127.0.0.1:18089`; MCP binds to
`127.0.0.1:18300` with `/mcp` and `/health`. Solver and Valkey services have
**no published host ports**. Containers use private service names such as
`http://searxng:8080` and `http://flaresolverr:8191`. From a separate computer,
use a controlled SSH tunnel or configure authenticated TLS ingress following
the [HTTP deployment guide](http-server.md) and [security policy](../SECURITY.md).
Do not change loopback bindings to public bindings without that ingress work.

The Compose bridge permits outbound access to search providers and source
pages. A network marked `internal: true` alone would remove that access.
Unpublished ports limit inbound exposure; they are not an outbound firewall.
The host and other containers on the same network remain trusted. Restrict
solver egress separately if required, because a browser can follow redirects
and load page subresources within that trusted service.
[Docker documents these network properties](https://docs.docker.com/reference/compose-file/networks/).

## Check readiness and results

For the base mode:

```bash
docker compose -f compose.yml ps
docker compose -f compose.yml exec -T valkey valkey-cli ping
curl --fail --silent --show-error http://127.0.0.1:18089/config
curl --fail --silent --show-error --get http://127.0.0.1:18089/search \
  --data-urlencode 'q=PostgreSQL EXPLAIN ANALYZE documentation' \
  --data-urlencode 'format=json' \
  --data-urlencode 'language=en-US' \
  --data-urlencode 'safesearch=1'
curl --fail --silent --show-error http://127.0.0.1:18300/health
```

Require parseable JSON, actual results or useful metadata, and inspect
`unresponsive_engines`. `/config` and MCP `/health` check service availability,
not engine quality. The final recipe's first cold-start search encountered
temporary DNS failure despite healthy containers; repeating after DNS recovered
produced results. Include an actual search in readiness verification.

For FlareSolverr, add `-f flare.yml` and check its API inside the container:

```bash
docker compose -f compose.yml -f flare.yml exec -T flaresolverr \
  curl --fail --silent --max-time 3 http://127.0.0.1:8191/health
```

For Byparr, the tested cheap API check follows `/` to its documentation:

```bash
docker compose -f compose.yml -f byparr.yml exec -T byparr \
  curl --fail --silent --location --max-time 3 http://127.0.0.1:8191/
```

Byparr's `/health` timed out in the live test, so this recipe does not use it.
The root check is **API liveness only**; it does not exercise a browser.
Connect an MCP client to `http://127.0.0.1:18300/mcp`, initialize the negotiated
protocol and run the search example plus `web_url_read` on a representative
source. A direct HTTP GET to `/mcp` is not an MCP tool test.

```json
{
  "name": "web_url_read",
  "arguments": {
    "url": "https://www.scrapingcourse.com/cloudflare-challenge",
    "maxLength": 12000
  }
}
```

The test target is public and can change. Compare a fresh direct GET with the
MCP content assertion; a solver health response or returned cookies alone do
not prove that the page was read. Prefer your own representative allowed target
for ongoing checks, at low rate. Do not log browser cookies or full page bodies.

## Understand solver behavior and budgets

Current MCP requests rendered content (`returnOnlyCookies=false`). On each
uncached URL read it validates the target and performs the HEAD size preflight
before attempting configured providers. It can consume validated rendered HTML
directly. Byparr responses explicitly labeled `application/pdf` must contain
bounded, canonical base64 with a PDF signature before isolated extraction.
Recognized viewer shells or ambiguous content use guarded replay with browser
cookies/user-agent and fresh URL/DNS checks. See the complete
[URL reader contract](../CONFIGURATION.md#url-reader-controls).

| Concern | Profile value / behavior |
|---|---|
| Provider order | FlareSolverr first, then Byparr when the ordered retry path permits it. |
| Flare acquisition | `FLARESOLVERR_TIMEOUT_MS=60000` (milliseconds). |
| Byparr acquisition | `BYPARR_TIMEOUT_SECONDS=60` (whole seconds). |
| Provider response grace | Up to five seconds beyond each acquisition budget. |
| Replay fetch | `FETCH_TIMEOUT_MS` retains its application default of `10000` milliseconds; it is separate from browser acquisition. |
| Provider capacity | One acquisition per provider per MCP process in these overlays; application default is two. A full provider waits at most one second, with a bounded queue. |
| HTTP request lifetime | `MCP_HTTP_STATELESS_REQUEST_TIMEOUT_MS=180000` for the example; application default is `900000`. Allow room for both providers, replay and parsing, plus a compatible client/ingress timeout. |
| URL cache | `CACHE_TTL_MS=300000`; a cache hit avoids a fresh browser/read operation. |
| Browser resources | Each example solver has 1.5 GiB memory ceiling, one CPU ceiling and 512 MiB `/dev/shm`. Measure peaks before raising concurrency. |

Dual mode is optional resilience, not a guarantee. A stopped FlareSolverr was
tested with both endpoints configured, followed by a successful Byparr read.
Rate limits, cancellation, unsafe DNS/redirects, invalid solver content and
credential-output checks can stop the chain. Direct fetching may still fail
after acquisition; keep the final content/status check. The default mode is
appropriate when direct reads already work, since browsers add latency and
memory to every uncached read when configured.

The tested Byparr PDF target returned Firefox viewer controls mixed into paper
text. Do not treat Byparr's HTTP/tool success as clean PDF extraction. For that
target FlareSolverr produced the paper title and abstract through guarded
replay; this does not promise success on every protected PDF.

## Keep proxy, identity and trust consistent

The supplied stack was tested with direct egress, without an outbound proxy.
Proxy configurations below describe the integration boundary and are not a
separately verified proxy deployment recipe:

| Traffic | Configuration boundary |
|---|---|
| MCP to SearXNG | `SEARCH_HTTP_PROXY` / `SEARCH_HTTPS_PROXY`, falling back to `HTTP_PROXY` / `HTTPS_PROXY`; `SEARCH_USER_AGENT` falls back to `USER_AGENT`. |
| MCP URL replay | `URL_READER_HTTP_PROXY` / `URL_READER_HTTPS_PROXY`, falling back to the globals; direct reads use `URL_READER_USER_AGENT` / `USER_AGENT`, while replay uses the returned browser identity. |
| Local service destinations | `NO_PROXY` applies to MCP's outbound proxy selection. Keep internal SearXNG and solver names reachable; do not send service credentials through an unintended proxy. |
| SearXNG to engines | SearXNG's own outgoing network/proxy configuration, independent of MCP. |
| Solver browser to target | The solver deployment's own network and proxy configuration, independent of MCP variables. |

Acquisition and replay need compatible public egress, DNS and browser identity.
Changing only an MCP proxy cannot force a remote browser to share that path.
TLS trust is also per process/container; do not disable certificate verification
to work around a private CA. Follow the [proxy reference](../CONFIGURATION.md#proxy)
and [solver trust boundary](../SECURITY.md#delegated-browser-service).

The solver receives the original target URL. Use only a trusted service and
avoid sending credential-bearing or private URLs unintentionally. The sample
keeps HTML logging disabled for FlareSolverr. Solver logs may still reveal URL
paths and queries; control access, retention and diagnostic collection.

## Diagnose, upgrade and roll back

| Observation | Next check |
|---|---|
| All engines time out together | Container DNS and outbound connectivity before raising engine timeouts. |
| One engine reports 403, CAPTCHA or 429 | Respect suspension/backoff; remove it from the recommended default set until a paced retest succeeds. |
| JSON succeeds but output looks stale | Search cache marker, exact arguments and TTL; inspect a fresh request. |
| Solver API is healthy but a read fails | Target status/content, browser startup, acquisition timeout and replay path. |
| Browser fails under traffic | Memory/OOM state, CPU throttling and shared-memory usage; lower workload before raising concurrency. |
| PDF output contains toolbar/alt-text controls | Viewer HTML was returned; count it as a failed clean extraction. |

For dual mode, observe the exact stack:

```bash
docker compose -f compose.yml -f flare.yml -f byparr.yml stats --no-stream
docker compose -f compose.yml -f flare.yml -f byparr.yml ps
docker compose -f compose.yml -f flare.yml -f byparr.yml logs --tail 50 mcp searxng
```

Read logs privately and redact credentials, cookies, target query strings and
personal data before sharing. Resource samples from one caller do not establish
a safe multi-user capacity limit. Keep the [historical MCP measurements](deployment-profiles.md)
separate from SearXNG and browser sizing.

Back up `.env`, settings, Compose files and the built MCP image/source revision
privately. Change one pinned image or setting at a time in a separate project;
run the same direct searches, MCP calls and content assertions before adopting
it. Restoring the previous files and image references then recreating only the
affected services is the rollback. A settings file edit alone does not reload
the running SearXNG process; restart that service through the same Compose file
list and repeat the checks. Never restart unrelated application stacks.

To remove this example's disposable stack, use its complete file list:

```bash
docker compose -f compose.yml -f flare.yml -f byparr.yml down
```

This keeps the settings and `.env` files. Retain or remove those private files
according to your local secret-handling policy. Upstream provider references:
[FlareSolverr](https://github.com/FlareSolverr/FlareSolverr) and
[Byparr](https://github.com/ThePhaseless/Byparr).
