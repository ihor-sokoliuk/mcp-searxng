# Deploy SearXNG, MCP and optional browser solvers

Use the [search configuration guide](search-configuration.md) to choose engines
and preserve result metadata. This recipe starts a separate private stack from
an MCP source checkout. It provides four modes: no solver, FlareSolverr, Byparr,
or ordered dual-provider failover. The [dated verification](search-configuration-verification.md)
identifies the exact tested versions, failures and limits.

## Start a private stack

The files are in [examples/search-stack](examples/search-stack/compose.yml).
The base Compose file builds the MCP Dockerfile from `MCP_SOURCE_DIR`. SearXNG, Valkey and
solver images use immutable manifest digests. The sample resources were
exercised with paced single-client traffic on Linux amd64; they are not a
production concurrency benchmark.

Keep writable SearXNG settings outside the source checkout. The upstream
entrypoint changes their ownership; mounting the tracked template directory
caused a later MCP build to fail while Docker collected that unreadable build
context. The example requires `SEARXNG_SETTINGS_DIR` for this reason.

From the root of a source checkout, create a persistent private deployment directory on a
Linux host with OpenSSL and `mktemp`. The directory holds Compose files,
`.env`, and writable settings **outside the MCP build context**. Migrate any
existing private deployment files out of the source checkout before building;
preserve existing secrets when migrating a running deployment. This block
generates a fresh secret only for a new deployment:

```bash
initialize_search_stack() {
  umask 077
  mcp_source_dir="$(pwd -P)" || return 1
  mkdir -p "$HOME/.local/share/mcp-search-stack" || return 1
  search_stack_dir="$(mktemp -d "$HOME/.local/share/mcp-search-stack/deployment.XXXXXX")" || return 1
  search_stack_dir="$(cd "$search_stack_dir" && pwd -P)" || return 1
  case "$search_stack_dir/" in
    "$mcp_source_dir/"*) printf 'Choose a deployment directory outside the source checkout.\n' >&2; return 1 ;;
  esac
  cp docs/examples/search-stack/*.yml "$search_stack_dir/" || return 1
  mkdir -m 700 "$search_stack_dir/settings" || return 1
  cp docs/examples/search-stack/settings/settings.yml "$search_stack_dir/settings/settings.yml" || return 1
  searxng_secret="$(openssl rand -hex 32)" || return 1
  printf 'SEARXNG_SECRET=%s\nMCP_SOURCE_DIR=%s\nSEARXNG_SETTINGS_DIR=%s\n' \
    "$searxng_secret" "$mcp_source_dir" "$search_stack_dir/settings" > "$search_stack_dir/.env" || return 1
  unset searxng_secret
  cd "$search_stack_dir" || return 1
  docker compose -f compose.yml config --quiet
}
initialize_search_stack
```

Initialization creates private files and validates the Compose model; it does
not start services. Choose a mode from the table below. The function returns an
error without closing the interactive shell if a setup step fails.

Run initialization once for a new deployment; preserve its directory and `.env`
for later starts. Run every command below from that private directory. The
tracked YAML files are templates; private copies are deployment configuration.
Keep `.env` out of version control and logs. `docker compose config` without
`--quiet` expands secrets, so use disposable values for shared reports.
`SEARXNG_SECRET` is SearXNG's cryptographic secret, not MCP or HTTP authentication.
Host-side administrative access may be needed after the SearXNG entrypoint
adjusts private settings ownership. Back up those files securely.

| Compose input | Purpose |
|---|---|
| `MCP_SOURCE_DIR` | Absolute source checkout to build; excludes the private deployment directory. |
| `SEARXNG_SETTINGS_DIR` | Absolute writable settings directory outside the source checkout. |
| `MCP_IMAGE` | Local build tag, default `mcp-searxng-search:local`; give a candidate its own tag. |
| `SEARXNG_HOST_PORT`, `MCP_HOST_PORT` | Loopback host ports, defaults `18089` and `18300`; distinct ports permit a parallel project. |

These inputs belong to Compose; the MCP container still listens on port 3000.

| Mode | Start command from the private deployment directory |
|---|---|
| No solver | `docker compose -f compose.yml up -d --build --wait` |
| FlareSolverr | `docker compose -f compose.yml -f flare.yml up -d --build --wait` |
| Byparr | `docker compose -f compose.yml -f byparr.yml up -d --build --wait` |
| Dual | `docker compose -f compose.yml -f flare.yml -f byparr.yml up -d --build --wait` |

Keep the same file list for `ps`, `logs`, `exec`, upgrades and `down`. To switch
back to no solver, recreate MCP with only the base file and stop/remove solver
services using the previous full file list. Merely removing an overlay does not
stop an already-running solver container. For the supplied dual-mode files,
these exact commands remove the optional providers and recreate MCP in base mode:

```bash
docker compose -f compose.yml -f flare.yml -f byparr.yml stop flaresolverr byparr
docker compose -f compose.yml -f flare.yml -f byparr.yml rm -f flaresolverr byparr
docker compose -f compose.yml up -d --force-recreate --no-deps --wait mcp
```

The complete file list defines both optional services even if only one had
running containers. These commands target this Compose project only.

SearXNG binds to host `127.0.0.1:18089`; MCP binds to
`127.0.0.1:18300` with `/mcp` and `/health`. Solver and Valkey services have
**no published host ports**. Containers use private service names such as
`http://searxng:8080` and `http://flaresolverr:8191`. From a separate computer,
use a controlled SSH tunnel or configure authenticated TLS ingress following
the [HTTP deployment guide](http-server.md) and [security policy](../SECURITY.md).
Do not change loopback bindings to public bindings without that ingress work.

The base mode is unauthenticated and non-hardened. MCP checks every present
`Origin` against its loopback defaults even with a `0.0.0.0` container bind;
requests without `Origin` remain valid for native clients. Host enforcement /
DNS-rebinding protection is enabled by `MCP_HTTP_HARDEN=true`, not by the bind
address or `MCP_HTTP_ALLOWED_HOSTS` alone. Loopback publishing is not
application authentication. Use the existing [hardened HTTP procedure](http-server.md#choose-authentication)
for an untrusted local/browser environment or remote ingress; it requires a
token or OAuth plus explicit origin/Host configuration. That hardened ingress
is a separate recipe, not a newly tested mode claimed here.

The Compose bridge permits outbound access to search providers and source
pages. A network marked `internal: true` alone would remove that access.
Unpublished ports limit inbound exposure; they are not an outbound firewall.
The host and other containers on the same network remain trusted. The supplied
shared bridge lets solver browsers reach SearXNG, MCP and Valkey; it is not
service-level network isolation. A separate solver network and browser-egress
firewall were not tested in this recipe. Restrict
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

Back up private `.env`, settings and Compose files before editing. Preserve the
running MCP build before rebuilding its tag; for base mode:

```bash
before_mcp_image="$(docker compose -f compose.yml images -q mcp)"
docker image tag "$before_mcp_image" mcp-searxng-search:before-update
```

From the candidate source checkout at the revision you intend to evaluate, run
the initialization block to create a second private deployment. Its
`MCP_SOURCE_DIR` will point to that checkout. Before starting services, give
its project, host ports and MCP build tag distinct values. For a base-mode
candidate, from its private deployment directory:

```bash
MCP_IMAGE=mcp-searxng-search:candidate SEARXNG_HOST_PORT=18090 MCP_HOST_PORT=18301 \
  docker compose -p mcp-search-candidate -f compose.yml up -d --build --wait
```

Use the same project name, environment values and complete provider file list
for subsequent commands. Its settings directory and `.env` must also be
separate from the running deployment. Test direct searches, MCP calls and actual
content reads before adopting it. Change one pinned image or setting at a time.
These alternate ports/tag and two-project startup were exercised; substitute
other free ports if needed.

For rollback, restore the previous private files and immutable upstream image
references. From the original deployment directory, select the saved MCP image
without rebuilding it:

```bash
MCP_IMAGE=mcp-searxng-search:before-update \
  docker compose -f compose.yml up -d --no-build --force-recreate --wait
```

Add the same solver overlay files when those providers were in use. Verify the
running image ID equals the saved image ID, then repeat health/content checks.
Do not use `--build` on this rollback command: it would overwrite the saved tag.
A settings edit alone does not reload SearXNG; restart only that service with
the same file list and repeat the checks. Never restart unrelated stacks.

To remove this example's disposable stack, use its complete file list:

```bash
docker compose -f compose.yml -f flare.yml -f byparr.yml down
```

This keeps the external private settings and `.env` files. Retain or remove those private files
according to your local secret-handling policy. Upstream provider references:
[FlareSolverr](https://github.com/FlareSolverr/FlareSolverr) and
[Byparr](https://github.com/ThePhaseless/Byparr).
