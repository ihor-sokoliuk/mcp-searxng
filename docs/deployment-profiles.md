# Measured MCP Deployment Profiles

These profiles are starting points for the **mcp-searxng process only**. They
do not size SearXNG, Redis, a reverse proxy, or any upstream search engine.
Measure your own workload before enforcing a production limit.

## Measurement snapshot

The baseline below was captured on 2026-07-29 from source commit
`ecd0b7c99941d8e204d633676873058b2a07fffe`:

- locally built mcp-searxng 1.12.1 production image;
- Node 24.18.0 on `linux/amd64`;
- Docker Engine 29.6.2 under Docker Desktop;
- 24 virtual CPUs and 15.18 GiB assigned to the Docker VM;
- one or two deterministic mock SearXNG replicas with 75 ms response latency;
- 20-result search responses and approximately 48 KiB HTML pages;
- Docker CPU and memory sampled with `docker stats --no-stream`.

This repository retains the point-in-time description and results below, but
not the benchmark harness or raw `docker stats` output. The snapshot therefore
cannot be independently rerun from repository artifacts alone. Treat it as
historical starting evidence and measure the current image with your own
representative workload before enforcing limits.

The snapshot did not exercise FlareSolverr acquisition or PDF text extraction.
PDF reads can use two PDF extractions concurrently per MCP process. Each parse
accepts at most 16 MiB of input, rejects documents above 500 pages, has a
separate 30-second budget, and runs with a 192 MiB V8 old-generation ceiling
plus a 4 MiB stack ceiling. The 192 MiB value is not a reservation, a complete
worker-memory bound, or a container-memory recommendation.

Each client opened its own Streamable HTTP session. Every cycle called
`searxng_web_search`, `web_url_read`, `searxng_search_suggestions`, and
`searxng_instance_info`. Queries rotated across four cache keys, search pages
alternated between `pageno` 1 and 2, URL reads used a 12,000-character window,
and the first capability call refreshed `/config`.

| Profile | Concurrent sessions | Tool calls | Measured duration | Observed memory | Average CPU | Peak CPU |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Small | 1 | 160 | 6.03 s | 52.39-110.60 MiB | 8.72% | 11.39% |
| Balanced | 4 | 480 | 6.06 s | 53.43-139.30 MiB | 20.39% | 31.84% |
| Research-heavy | 8 | 960 | 6.06 s | 53.63-254.40 MiB | 40.80% | 65.32% |

Docker CPU percentages use one logical CPU as approximately 100%. The balanced
run configured two replicas in default failover mode. The research-heavy run
queried two replicas with `SEARXNG_FANOUT=true`. The small, balanced, and
research-heavy cache caps were 100, 500, and 2,000 entries respectively.

This is a short, deterministic MCP overhead sample, not a soak test or an SLA.
Real pages, response sizes, TLS, proxies, logging, cache cardinality, Node
versions, and client behavior can move both CPU and memory. The ranges below
add headroom to this sample; each is a starting range, not a universal
requirement.

## Starting profiles

| Profile | Intended MCP workload | CPU starting range | Memory starting range |
| --- | --- | ---: | ---: |
| Small | 1-2 mostly sequential clients, one SearXNG URL, modest caches | 0.25-0.50 CPU | 192-256 MiB |
| Balanced | About 4 concurrent clients, replicas in failover mode, default-sized caches | 0.50-1.00 CPU | 256-384 MiB |
| Research-heavy | About 8 concurrent sessions, fan-out or large caches, frequent 12 KiB page reads | 1.00-2.00 CPU | 512-768 MiB |

Start at the lower end only when the measured workload resembles the baseline.
Use the upper end when pages are larger, cache keys are less reusable, TLS or
proxy work is significant, or concurrency arrives in bursts. Treat an
out-of-memory kill or sustained CPU throttling as evidence that the enforced
limit is too low, not as an application retry condition.

The optional 256 MiB balanced container overlay is a measured non-PDF starting
point. It may be insufficient when representative traffic can reach the
two-worker PDF concurrency limit. Measure PDF and FlareSolverr-enabled traffic
before enforcing a memory ceiling.

## Apply a profile

### NPX and STDIO

NPX does not impose CPU or memory limits. Set the profile's mcp-searxng
environment variables in the MCP client, observe the Node process with the
operating system's process monitor, and use an operating-system or service
manager limit only after measuring that client workload.

One STDIO process normally serves one client connection. Multiple clients that
launch separate NPX processes need the profile allowance **per process**.

### Docker and STDIO

Docker's `--cpus` and `--memory` flags place ceilings on the MCP container. For
the balanced starting point:

```bash
docker run -i --rm \
  --name mcp-searxng-profile \
  --cpus 0.50 \
  --memory 256m \
  -e SEARXNG_URL=https://searxng.example.com \
  isokoliuk/mcp-searxng:latest
```

For STDIO, keep `-i`; do not publish an HTTP port. Replace the two resource
values with the selected profile and watch for throttling or OOM termination.

### Standalone HTTP with Compose

The base `docker-compose.yml` remains STDIO-only. Add
`docker-compose.http.yml` to enable a standalone hardened Streamable HTTP
service, and optionally add `docker-compose.resources.yml` for balanced
resource defaults.

Before starting it, set `SEARXNG_URL`, `MCP_HTTP_AUTH_TOKEN`, and
`MCP_HTTP_ALLOWED_ORIGINS` in the operator environment. Compose fails during
interpolation, before creating a container, if either hardening value is
missing.

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.http.yml \
  -f docker-compose.resources.yml \
  up -d
```

The published endpoint defaults to `127.0.0.1:3000`. Change the host-side
address only with `MCP_SEARXNG_HTTP_BIND_ADDRESS`, and change the host-side port
only with `MCP_SEARXNG_HTTP_PUBLISHED_PORT`. `MCP_HTTP_PORT` controls the
container-side listener and defaults to `3000`; the overlay sets
`MCP_HTTP_HOST=0.0.0.0` inside the container so Docker port forwarding can reach
it.

If `MCP_SEARXNG_HTTP_PUBLISHED_PORT` differs from `MCP_HTTP_PORT`, add the
client-visible host and published port in `MCP_HTTP_ALLOWED_HOSTS`. Hardened
mode derives its loopback defaults from the container-side `MCP_HTTP_PORT`,
while clients send the host-side port in the `Host` header.

For example, choose another point in the measured resource ranges without
changing the loopback-only network default:

```bash
MCP_SEARXNG_CPUS=1.50 \
MCP_SEARXNG_MEMORY_LIMIT=768m \
MCP_SEARXNG_MEMORY_RESERVATION=512m \
docker compose \
  -f docker-compose.yml \
  -f docker-compose.http.yml \
  -f docker-compose.resources.yml \
  up -d
```

`MCP_SEARXNG_CPUS`, `MCP_SEARXNG_MEMORY_LIMIT`, and
`MCP_SEARXNG_MEMORY_RESERVATION` are Compose interpolation variables, not
mcp-searxng application settings. Compose `cpus` is a CPU ceiling,
`mem_limit` is the memory ceiling, and `mem_reservation` is the requested
reservation. See Docker's current
[Compose service reference](https://docs.docker.com/reference/compose-file/services/)
and [container resource guidance](https://docs.docker.com/engine/containers/resource_constraints/).

When `MCP_HTTP_ALLOWED_HOSTS` is unset, hardened mode accepts the existing
loopback hostname defaults and their configured-port forms. Setting it replaces
those defaults, so list the exact `Host` forwarded by a reverse proxy.
`MCP_HTTP_TRUST_PROXY` is also optional and disabled by default. Enable it only
for a known proxy topology; otherwise clients can spoof `X-Forwarded-For` and
therefore the IP identity used for rate limiting and logs.

The overlay uses Compose pass-through syntax for those two optional variables.
When either is absent from the operator environment, Compose passes no value for
an optional variable. The server also treats a blank allowed-hosts value as
unset and a blank trust-proxy value as disabled, preserving the safe defaults.

To inspect the merged model before launch, supply only a disposable placeholder
token:

```bash
MCP_HTTP_AUTH_TOKEN=compose-test-token \
MCP_HTTP_ALLOWED_ORIGINS=https://client.example.invalid \
SEARXNG_URL=https://searxng.example.com \
docker compose \
  -f docker-compose.yml \
  -f docker-compose.http.yml \
  -f docker-compose.resources.yml \
  config
```

`docker compose config` prints expanded environment values, including
`MCP_HTTP_AUTH_TOKEN`. Never run or capture that command with a real production
token in CI logs or shared output.

Follow [Hardened HTTP Mode](../CONFIGURATION.md#hardened-http-mode) for exact
Host, Origin, TLS, and reverse-proxy guidance. Resource limits do not replace
authentication, Host/Origin validation, TLS, or rate limiting.

## Map workload to current controls

| Concern | Current control | Capacity effect |
| --- | --- | --- |
| Results per call | `SEARXNG_MAX_RESULTS` | A lower 1-20 ceiling reduces response processing and agent context. |
| URL timeout | `FETCH_TIMEOUT_MS` | Bounds how long a page read can occupy an in-flight request. |
| Solver timeout | `FLARESOLVERR_TIMEOUT_MS` | Bounds browser-session acquisition separately from the target replay fetch. |
| Solver concurrency | `FLARESOLVERR_MAX_CONCURRENT_REQUESTS` | Bounds acquisitions per MCP process; excess requests use the direct path instead of queuing. |
| Search cache | `SEARCH_CACHE_TTL_MS`, `SEARCH_CACHE_MAX_ENTRIES` | Larger or longer-lived caches trade memory for fewer upstream searches. |
| URL output | `URL_READ_MAX_CHARS` | Sets the default returned window when the caller omits `maxLength`. |
| URL body cap | `URL_READ_MAX_CONTENT_LENGTH_BYTES` | Bounds decompressed bytes read before conversion; the default is 5 MiB. |
| PDF extraction | Fixed limits | At most two PDF extractions run concurrently; each uses a 16 MiB input/output ceiling, 500-page limit, 30-second budget, 192 MiB V8 old-generation ceiling, and 4 MiB stack ceiling. |
| URL cache | `CACHE_TTL_MS`, `CACHE_MAX_ENTRIES` | Larger or longer-lived caches trade memory for fewer page fetches. |
| Replica mode | `SEARXNG_FANOUT` | Fan-out increases simultaneous upstream work; default failover is cheaper. |
| HTTP window | `MCP_RATE_WINDOW_MS` | Defines the rate-limit accounting window. |
| New sessions | `MCP_RATE_INIT_MAX` | Bounds initialization and invalid-session POST traffic per client IP. |
| Live sessions | `MCP_RATE_SESSION_MAX` | Bounds established-session HTTP traffic per client IP. |

Do not raise cache caps and concurrency together without observing memory.
Do not use a short `FETCH_TIMEOUT_MS` to compensate for insufficient CPU.
Pagination and larger result counts increase total work even when each call
stays within its individual bound.

## Observe and adjust

For the named `docker run` example, sample the container during representative
traffic:

```bash
docker stats --no-stream mcp-searxng-profile
docker inspect mcp-searxng-profile \
  --format '{{.State.OOMKilled}} {{.RestartCount}}'
```

For the three-file Compose HTTP profile, address the service through Compose
instead of assuming Docker's generated container name:

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.http.yml \
  -f docker-compose.resources.yml \
  stats --no-stream mcp-searxng

container_id="$(docker compose \
  -f docker-compose.yml \
  -f docker-compose.http.yml \
  -f docker-compose.resources.yml \
  ps -q mcp-searxng)"
docker inspect "$container_id" --format '{{.State.OOMKilled}} {{.RestartCount}}'
```

Record the Node version, image digest, architecture, active environment,
concurrent sessions, call mix, page sizes, cache hit rate, sample duration, CPU
average/peak, memory low/peak, errors, and restarts. Repeat after material
changes to the workload or runtime.

Increase memory when normal peaks approach the ceiling or the container is
OOM-killed. Increase CPU when latency rises with sustained throttling. Reduce
cache caps or page/result limits when retained content is the cause. Scale out
to separate MCP instances when clients need different security policies,
SearXNG endpoints, cache lifecycles, failure domains, or when one process cannot
meet the measured concurrency target with acceptable headroom.

## SearXNG is a separate capacity plan

These measurements cover only the MCP adapter process. They exclude SearXNG
engine fan-out, Redis, result rendering, bot detection, and upstream network
behavior. Use the [self-hosted operator guide](self-hosted-searxng.md) for the
integration boundary and the
[SearXNG installation documentation](https://docs.searxng.org/admin/installation.html)
for the search service itself. This project does not bundle SearXNG, and this
guide does not size SearXNG.
