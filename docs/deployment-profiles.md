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
  --cpus 0.50 \
  --memory 256m \
  -e SEARXNG_URL \
  isokoliuk/mcp-searxng:latest
```

For STDIO, keep `-i`; do not publish an HTTP port. Replace the two resource
values with the selected profile and watch for throttling or OOM termination.

### Standalone HTTP with Compose

The optional `docker-compose.resources.yml` overlay applies balanced defaults
without changing the base Compose service:

```bash
SEARXNG_URL=https://searxng.example.com \
docker compose \
  -f docker-compose.yml \
  -f docker-compose.resources.yml \
  up -d
```

Choose another point in the measured ranges through Compose interpolation:

```bash
MCP_SEARXNG_CPUS=1.50 \
MCP_SEARXNG_MEMORY_LIMIT=768m \
MCP_SEARXNG_MEMORY_RESERVATION=512m \
SEARXNG_URL=https://searxng.example.com \
docker compose \
  -f docker-compose.yml \
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

HTTP deployments also need the transport and security settings in
[Hardened HTTP Mode](../CONFIGURATION.md#hardened-http-mode). Resource limits
do not replace authentication, host/origin validation, TLS, or rate limiting.

## Map workload to current controls

| Concern | Current control | Capacity effect |
| --- | --- | --- |
| Results per call | `SEARXNG_MAX_RESULTS` | A lower 1-20 ceiling reduces response processing and agent context. |
| URL timeout | `FETCH_TIMEOUT_MS` | Bounds how long a page read can occupy an in-flight request. |
| Search cache | `SEARCH_CACHE_TTL_MS`, `SEARCH_CACHE_MAX_ENTRIES` | Larger or longer-lived caches trade memory for fewer upstream searches. |
| URL output | `URL_READ_MAX_CHARS` | Sets the default returned window when the caller omits `maxLength`. |
| URL body cap | `URL_READ_MAX_CONTENT_LENGTH_BYTES` | Bounds decompressed bytes read before conversion; the default is 5 MiB. |
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

For Docker or Compose, sample the MCP container during representative traffic:

```bash
docker stats --no-stream mcp-searxng
docker inspect mcp-searxng --format '{{.State.OOMKilled}} {{.RestartCount}}'
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

