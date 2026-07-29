# Operating Self-Hosted SearXNG with mcp-searxng

This guide assumes that you already operate a SearXNG service. mcp-searxng
connects to that service; it does not install SearXNG or read SearXNG's private
configuration. The examples below use non-secret placeholders. Adapt them to
your deployment and apply changes with the normal reload, restart, or rollout
procedure for your packaging or orchestrator.

## Responsibility boundary

| Concern | SearXNG | mcp-searxng | Shared boundary |
|---|---|---|---|
| Deployment and capabilities | Runs the metasearch service and exposes its configured formats, categories, providers, locales, and plugins. | Consumes the public search and administration APIs. | A capability must exist upstream before an MCP request can rely on it. |
| Request construction | Applies server defaults and forwards supported filters to upstream providers. | Initially builds upstream search requests with `format=json`, plus caller or operator defaults. | Language, safe search, categories, and engine filters can be set at both layers. |
| Results | Produces answers, results, suggestions, corrections, and provider error metadata. | Filters, limits, formats, deduplicates, and caches returned data. | Poor or empty output can originate upstream or from MCP-side filters, limits, or cache state. |
| Availability | Owns its process, storage, provider connectivity, and local recovery. | Selects configured replicas and performs ordered failover or optional fan-out. | Timeouts and partial failures must be diagnosed at both layers. |
| Network security | Owns ingress TLS, any front-end authentication, the limiter, Valkey, and reverse-proxy trust. | Owns MCP transport security, outbound proxy selection, credentials used for SearXNG, and Node.js CA trust. | Authentication, TLS, forwarded client identity, egress policy, and rate limiting require compatible settings on both sides. |

The two output controls have different jobs. `format=json` requests upstream SearXNG JSON.
`response_format` only controls the MCP-returned payload.
`response_format` does not enable upstream SearXNG JSON.

## Minimal SearXNG API overlay

Keep the operator overlay small and inherit maintained defaults:

```yaml
use_default_settings: true

search:
  safe_search: 1
  default_lang: "en"
  formats:
    - html
    - json

server:
  secret_key: "replace-with-a-generated-secret"
  base_url: "https://search.example.com/"
  limiter: true

valkey:
  url: "valkey://valkey:6379/0"
```

Store this as the deployment's SearXNG settings overlay, commonly
`/etc/searxng/settings.yml`. Generate a unique `server.secret_key` and inject it
through the secret mechanism supported by your deployment; the literal
placeholder is not safe for service use. `server.base_url`, the language, the
safe-search level, and the Valkey address are deployment decisions. The Valkey
hostname must resolve on the network where SearXNG runs.

The `search.formats` list must contain `json` because mcp-searxng uses JSON as
its primary search path. When `SEARXNG_HTML_FALLBACK=true`, a denied or
non-JSON response may be retried without `format=json`. Keeping `html` also
preserves the ordinary browser interface.
The language and safe-search values are defaults, not guarantees: a caller can
override them, and an upstream provider may not support every filter.

## Search inventory and defaults

With `use_default_settings: true`, SearXNG merges the local overlay with its
maintained defaults. Entries under `engines` are merged by the exact `name`
field, so an override must match the configured name exactly.

`disabled: true` keeps an entry available for a user to activate, while
`inactive: true` removes it from the available settings surface. Some entries
that require credentials start inactive until their required configuration is
present. A single entry can belong to multiple categories, and each provider
can differ in language, safe-search, paging, and time-range support.

Treat the inventory as deployment-specific. Do not copy a static list from this
guide. Inspect the active SearXNG preferences and public capability response,
then make targeted overrides based on the service's purpose, provider terms,
and observed health.

## Limiter, proxy, and security

An Internet-facing SearXNG service needs deliberate protection:

1. Set `server.limiter: true`.
2. Confirm that SearXNG can connect to the configured Valkey database.
3. Forward the real client identity through the reverse proxy as documented by
   SearXNG.
4. Keep `trusted_proxies` limited to the proxy hops that actually terminate
   traffic for the service.

`server.public_instance: true` activates public-instance features but does not
turn on the limiter by itself. Incorrect forwarded headers can collapse many
clients into one identity or allow spoofed identities. An overly broad
`trusted_proxies` list weakens that boundary.

Terminate TLS with a valid certificate at the intended ingress. If a front-end
proxy provides HTTP Basic authentication, mcp-searxng must send credentials for
that endpoint. The SearXNG `server.secret_key` is a separate cryptographic
secret and is not an HTTP authentication password.

Follow the official [limiter documentation](https://docs.searxng.org/admin/searx.limiter)
and the proxy example matching your ingress, such as
[NGINX](https://docs.searxng.org/admin/installation-nginx.html) or
[Apache](https://docs.searxng.org/admin/installation-apache.html). Also apply
the mcp-searxng [security policy and deployment guidance](../SECURITY.md).

## Verify SearXNG directly

Run these checks once after a configuration change, at low rate, from a host
that follows the same authentication, DNS, proxy, and TLS path as
mcp-searxng:

```bash
curl --fail-with-body --silent --show-error \
  "https://search.example.com/config"

curl --fail-with-body --silent --show-error --get \
  "https://search.example.com/search" \
  --data-urlencode "q=operator verification" \
  --data-urlencode "format=json"
```

The first response inventories public categories, configured entries,
defaults, locales, and plugins. A successful response from
`https://search.example.com/config` does not prove that JSON search is enabled;
only the second request verifies the JSON path. Require an HTTP success status
and a parseable JSON body. Do not treat an HTML error page as JSON.

Interpret failures conservatively:

- HTTP 401 points to missing or rejected front-end credentials.
- HTTP 403 means that the requested capability was denied somewhere in the
  request path. It does not identify one specific setting by itself.
- HTTP 429 means stop and back off. Do not bypass or load-test the protection.
- HTTP 5xx points to SearXNG, a reverse proxy, or an upstream dependency.
- A successful response can still report partial provider degradation; inspect
  its error metadata before declaring the search path healthy.

## Configure mcp-searxng

For one controlled service, set one base URL:

```text
SEARXNG_URL=https://search.example.com
SEARXNG_FANOUT=false
```

For interchangeable controlled replicas, separate base URLs with semicolons:

```text
SEARXNG_URL=https://search-a.example.com;https://search-b.example.com
SEARXNG_FANOUT=false
```

The default mode tries replicas in order. A hard failure is recorded for
cooldown; an empty successful response can lead to the next replica without
marking the first one unhealthy. Only group services whose policies,
credentials, capabilities, and expected data are interchangeable.

`SEARXNG_FANOUT=true` queries all healthy replicas in parallel, deduplicates by
canonical URL, and merges results. It can improve availability or coverage, but
it multiplies request load and can reach upstream limits sooner. Enable it only
after accounting for capacity, quotas, latency, and privacy at every replica.

The most relevant existing controls are:

| Setting | Operator effect |
|---|---|
| `SEARXNG_URL` | One base URL or a semicolon-separated replica set. URL userinfo can carry per-replica HTTP Basic credentials. |
| `SEARXNG_FANOUT` | Chooses ordered failover or parallel fan-out. |
| `AUTH_USERNAME`, `AUTH_PASSWORD` | Legacy global Basic Auth fallback only when a URL entry has no userinfo. |
| `SEARXNG_TIMEOUT_MS` | Bounds each SearXNG search response wait; default `10000`. |
| `SEARXNG_DEFAULT_LANGUAGE` | Supplies the MCP request language when the caller omits it; default `all`. |
| `SEARXNG_DEFAULT_SAFESEARCH` | Supplies safe search when the caller omits it; otherwise the instance default applies. |
| `SEARXNG_MAX_RESULTS`, `SEARXNG_MAX_RESULT_CHARS` | Apply operator ceilings to returned result count and snippet length. |
| `SEARCH_CACHE_TTL_MS`, `SEARCH_CACHE_MAX_ENTRIES` | Control the per-process in-memory search cache; defaults are `86400000` and `200`. |
| `SEARXNG_HTML_FALLBACK` | Optionally retries certain denied, missing, or non-JSON responses as HTML with reduced metadata; default `false`. |
| `SEARCH_USER_AGENT`, `USER_AGENT` | Set the search-specific identity or its global fallback. |
| `SEARCH_HTTP_PROXY`, `SEARCH_HTTPS_PROXY` | Override the global `HTTP_PROXY` and `HTTPS_PROXY` for SearXNG traffic. |
| `NO_PROXY` | Bypasses proxying for explicitly listed destinations. |
| `NODE_EXTRA_CA_CERTS` | Adds a PEM CA bundle to Node.js trust when the deployment requires it. |

Keep credentials, TLS trust, and egress rules separate for the SearXNG service
and the MCP service. The complete variable reference, including URL-reader and
HTTP transport settings, is in [CONFIGURATION.md](../CONFIGURATION.md).

## Inspect the MCP capability surface

Invoke `searxng_instance_info` after direct verification. With
`includeEngines=true`, it reports enabled names; `includeDisabled=true` adds
disabled names; `category` narrows the view; and `refresh=true` bypasses the
process capability cache.

For multiple replicas:

- `categories.common` and `engines.common.enabled` are the intersection across
  reachable replicas and are the safest filter choices for consistent results.
- `categories.available` and `engines.available.enabled` are the union and can
  work on only part of the replica set.
- Reachable and unreachable replica summaries expose capability drift without
  revealing URL credentials.
- Defaults, locales, and plugins come from the primary reachable replica and
  can differ elsewhere.

The tool aggregates the public capability response. It cannot prove JSON
support, reveal secrets, show private settings, or certify provider health.
Compare it with the direct JSON search instead of treating it as a complete
configuration dump.

## Transport and trust boundaries

STDIO is the simplest transport when the MCP server and client run in the same
local trust boundary. When MCP HTTP transport is reachable over a network,
follow [Hardened HTTP Mode](../CONFIGURATION.md#hardened-http-mode) and the
[public HTTP deployment guidance](../SECURITY.md#public--internet-facing-http).
Configure authentication, origin checks, trusted proxy handling, rate limits,
and TLS at that MCP boundary as well as at SearXNG.

Outbound proxy settings do not secure inbound MCP traffic. Likewise,
SearXNG's limiter does not rate-limit the MCP HTTP endpoint. Each layer needs
its own narrowly scoped controls.

## Reliability and troubleshooting

Work in this order so cache or replica behavior does not hide the failing
layer:

1. **HTTP status:** Repeat the two direct low-rate checks. Resolve
   authentication, denial, throttling, or server errors before changing MCP
   filters.
2. **Invalid JSON:** Confirm that `search.formats` still includes `json`, that
   the search request succeeds, and that a proxy is not replacing the body
   with HTML. `SEARXNG_HTML_FALLBACK` is a compatibility measure, not proof of
   a healthy JSON API.
3. **Partial degradation:** Inspect the JSON error metadata and SearXNG logs.
   A useful result set can coexist with unavailable providers.
4. **Empty or poor results:** Compare the same query directly and through
   `searxng_web_search`. Repeat without optional category, engine, language,
   time, safe-search, score, or result-count filters to isolate the constraint.
5. **Capability drift:** Call `searxng_instance_info` with `refresh=true` and
   compare its inventory with the direct capability response after SearXNG
   configuration changes.
6. **Replica differences:** Run the direct checks against each configured base
   URL. Compare common and available capability sets before relying on a
   replica-specific filter.
7. **Timeouts:** Compare SearXNG provider timeouts, reverse-proxy timeouts, and
   `SEARXNG_TIMEOUT_MS`. Increasing only the outer timeout cannot repair an
   upstream denial or broken dependency.
8. **Cache effects:** Search results are cached in each MCP process. A repeated
   request can reflect earlier data until `SEARCH_CACHE_TTL_MS` expires.
   Capability refresh does not clear the search-result cache. If an intentional
   process restart is needed, perform it through the deployment's normal
   controlled procedure.

## Authoritative references

- [SearXNG Search API](https://docs.searxng.org/dev/search_api.html)
- [Administration API](https://docs.searxng.org/admin/api.html)
- [Settings overlay and merge behavior](https://docs.searxng.org/admin/settings/settings.html)
- [Search settings](https://docs.searxng.org/admin/settings/settings_search.html)
- [Entry settings](https://docs.searxng.org/admin/settings/settings_engines.html)
- [Server settings](https://docs.searxng.org/admin/settings/settings_server.html)
- [Valkey settings](https://docs.searxng.org/admin/settings/settings_valkey.html)
- [Limiter](https://docs.searxng.org/admin/searx.limiter)
- [mcp-searxng configuration reference](../CONFIGURATION.md)
- [mcp-searxng security policy](../SECURITY.md)
