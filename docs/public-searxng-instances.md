# Using a Public SearXNG Instance with mcp-searxng

This guide is for users who can connect to a SearXNG service but do not
operate it. A public instance can be useful for evaluation or occasional
searches, but its operator controls availability, logging, enabled formats,
engines, limits, and acceptable use. For regular or sensitive workloads,
prefer an instance operated by someone you trust or
[run your own](self-hosted-searxng.md).

## Trust boundary

SearXNG limits what upstream search providers learn about an individual user,
but the SearXNG instance itself receives the query. With a public instance:

- the operator can observe or log queries and connection metadata;
- configuration, engines, limits, and availability can change without notice;
- shared egress addresses can be throttled or blocked by upstream providers;
- HTTPS protects the connection in transit but does not make the operator
  trusted; and
- mcp-searxng cannot inspect private settings or prove a logging policy from
  the public `/config` response.

Do not send secrets, personal data, internal identifiers, or confidential
queries to an operator you do not trust. Public SearXNG is not an anonymity
guarantee.

## Assess an instance without load-testing it

[searx.space](https://searx.space/) provides a changing inventory and
operational measurements. Treat it as a discovery aid, not an endorsement or
permanent allowlist. Before configuring an instance:

1. **Read its policy and contact information.** Check the instance's About,
   privacy, and contact links. Do not automate against an instance whose policy
   is missing, unclear, or incompatible with your use.
2. **Require HTTPS.** Confirm that the URL and certificate are valid for the
   intended hostname.
3. **Make one direct capability request.** A successful `/config` response can
   describe public categories, engines, locales, defaults, and plugins. It
   does not prove that JSON search is enabled or that every advertised engine
   is healthy.
4. **Make one small JSON search.** SearXNG returns `403` when the requested
   `format=json` output is not enabled, although a `403` can also come from an
   access-control or blocking layer.
5. **Check pagination only if you need it.** Request page 1 first and at most
   one later page during evaluation. Page support and result quality vary by
   enabled engine.

Example low-rate checks:

```bash
curl --fail-with-body --silent --show-error \
  "https://public.example/config"

curl --fail-with-body --silent --show-error --get \
  "https://public.example/search" \
  --data-urlencode "q=searxng verification" \
  --data-urlencode "format=json" \
  --data-urlencode "pageno=1"
```

Stop after a denial or rate-limit response. Do not probe a list of public
instances concurrently, repeatedly retry, bypass a CAPTCHA, or disguise
automation as a browser.

## Start with conservative MCP settings

Configure one public instance, keep fan-out disabled, and cap returned
results:

```json
{
  "SEARXNG_URL": "https://public.example",
  "SEARXNG_FANOUT": "false",
  "SEARXNG_TIMEOUT_MS": "10000",
  "SEARXNG_MAX_RESULTS": "5",
  "SEARXNG_HTML_FALLBACK": "false"
}
```

Use one URL rather than a semicolon-separated public-instance list. Ordered
failover can send one query to several independent operators after failures or
empty responses, while fan-out deliberately sends it to every healthy
configured instance. Both increase load and disclose the query more widely.

The existing search cache reduces identical upstream requests within one MCP
process. Its default TTL is 24 hours. Do not defeat the cache by continuously
changing equivalent queries.

If an operator publishes a User-Agent requirement, set
`SEARCH_USER_AGENT` to an honest, contactable identity they accept, for
example `YourAgent/1.0 (+https://example.com/contact)`. Do not use the setting
to impersonate a browser or evade bot detection.

## Use the advertised capabilities

After the direct checks, call `searxng_instance_info`:

- start without engine details to inspect categories, defaults, locales, and
  plugins;
- use `includeEngines=true` only when engine selection is needed;
- use `refresh=true` after an observed configuration change; and
- treat an unavailable `/config` response as missing information, not proof
  that search is unavailable.

For `searxng_web_search`, begin with `pageno=1` and a small
`num_results`. Omit `engines` and `categories` unless the current capability
response supports them. Language, safe-search, time-range, and paging support
can still vary by engine.

`response_format="json"` controls the MCP response returned to the client. It
does not enable SearXNG's upstream `format=json` capability.

## JSON rejection and HTML fallback

When `SEARXNG_HTML_FALLBACK=true`, mcp-searxng can retry a search without
`format=json` after:

- HTTP `403`;
- HTTP `404`; or
- a successful response that is not valid JSON.

The retry parses the ordinary HTML results page. On success it provides title,
URL, and snippet data, marks JSON output with `sourceFormat: "html"`, and omits
metadata that the page does not expose reliably, such as relevance scores and
engine names.

HTML parsing is best-effort and can break when an instance changes its theme
or markup. The fallback does not trigger for authentication failures, network
errors, `429`, or `5xx`, and it does not bypass an operator's controls. If the
HTML attempt fails, that attempt's error is returned.

Enable the fallback only when the operator permits ordinary HTML access and
you accept the extra request and reduced metadata. A public instance with JSON
enabled is more reliable for MCP use.

## Respond to failures conservatively

| Observation | Meaning and response |
|---|---|
| `401` | The endpoint requires credentials. Do not guess or bypass them. |
| `403` | JSON may be disabled, or an access-control/bot-protection layer may have denied the request. Verify the operator's policy before considering HTML fallback. |
| `404` | The base path or search endpoint may differ, or the endpoint may be unavailable. Recheck the published URL once. |
| `429` | Stop. Respect the operator's rate limit and wait for explicit policy guidance before trying again. |
| `5xx` or timeout | Treat the instance as unavailable. Do not create a rapid retry loop. |
| Non-JSON success | A proxy or HTML page may have replaced the expected body. Use the optional fallback only within policy. |
| Empty results | Remove optional engine, category, language, time, safe-search, and score filters, then make one simpler request. Empty results can also reflect upstream engine degradation. |
| Capability drift | Refresh `searxng_instance_info` once and adapt to the current public inventory. |

mcp-searxng does not currently provide automated public-instance discovery,
client-side request pacing/backoff controls, or structured zero-result retry
diagnostics. Keep selection and retry decisions explicit instead of assuming
those safeguards exist.

## When to self-host

Move to a trusted or self-hosted instance when:

- searches are regular, automated, high-volume, sensitive, or business
  critical;
- you need stable JSON, engine, language, safe-search, or pagination behavior;
- you need a defined logging, retention, location, or access-control policy;
- public limits or upstream blocking repeatedly reduce result quality; or
- you need replicas, fan-out, monitoring, or an availability objective.

The [self-hosted operator guide](self-hosted-searxng.md) covers SearXNG JSON
enablement, capability inventory, replicas, reliability, and security
boundaries for infrastructure you control.

## References

- [Why use a private instance?](https://docs.searxng.org/own-instance.html)
- [SearXNG Search API](https://docs.searxng.org/dev/search_api.html)
- [SearXNG public instance inventory](https://searx.space/)
- [mcp-searxng configuration reference](../CONFIGURATION.md)
- [mcp-searxng security guidance](../SECURITY.md)
