# Configure search for useful coverage

Start with the [tested settings overlay](examples/search-stack/settings/settings.yml)
and the [private deployment recipe](browser-solver-deployment.md). They use
upstream SearXNG without source patches. This is an English research starting
point, verified on 2026-10-04, rather than a universal engine ranking. Provider
availability depends on your IP, region, query and upstream changes; repeat the
[verification procedure](#verify-before-and-after) on your own deployment.

The filtered profile combines Yahoo, Bing and Mojeek, with explicit specialist
routes for other tasks. In a ten-query English/moderate-safe-search pass it
returned 203 result URLs, or 198 after tracking normalization, compared with
113/108 from Yahoo/Bing alone. Both passes were nonempty and error-free. The
optional unfiltered Yahoo/Bing/DuckDuckGo web route returned 131/124 URLs with
no engine errors across ten queries. Those are different workloads, not a
controlled filter comparison. Earlier larger engine sets returned more URLs
but later encountered CAPTCHA or throttling and were removed from the recipe.
Mojeek also rejected an unfiltered request; keep it out of that route. Counts
measure discovery coverage, not factual accuracy or future availability. See
the [dated results and failures](search-configuration-verification.md).

## Choose the layer to change

| Symptom | Check first | Setting or action |
|---|---|---|
| JSON search is denied | Direct `/search?format=json` request | Include `json` in SearXNG `search.formats`; check ingress authentication and limiter. |
| Direct search has too few useful sources | Engine contributions and `unresponsive_engines` | Select working complementary engines; use a specialist route or another page. |
| Direct JSON has more sources than MCP | MCP arguments and environment | Omit `num_results`; leave `SEARXNG_MAX_RESULTS` unset for broad coverage. |
| Papers or facts lose useful fields | MCP output format and detail | Use `response_format="json"`, `result_detail="full"`. |
| News repeats yesterday's output | Search cache marker | Use a shorter `SEARCH_CACHE_TTL_MS`; capability refresh does not clear result caches. |
| A discovered source returns a browser challenge | A fresh `web_url_read` | Test an optional trusted browser solver. It does not add search results. |

Solvers apply to `web_url_read`, after search has found a URL. They do not fix
SearXNG engines receiving CAPTCHA, 403 or 429 responses. A solver `/v1` API is
also not a general HTTP forward proxy: do not put its URL in SearXNG outgoing
proxy settings.

## Apply the SearXNG overlay

The supplied overlay uses `use_default_settings.engines.keep_only` to inherit
the upstream definitions for fourteen active engines and one explicitly selected query-only engine. This deliberately
limits the example's inventory. An existing deployment can instead merge only
the relevant named overrides into its own overlay; preserve its secret, ingress,
Valkey, category choices and unrelated engines. Exact names matter, including
spaces. [Upstream documents the merge rules](https://docs.searxng.org/admin/settings/settings.html).

| Overlay choice | Purpose and evidence |
|---|---|
| `search.formats: [html, json]` | Preserves the browser UI and enables the JSON API; both direct JSON and MCP requests were exercised. |
| `default_lang: en-US`, `safe_search: 1` | Tested English, moderate-safe-search defaults. Callers can override them; engine support varies. |
| `max_page: 0` | Adds no global page ceiling; lower engine limits still apply. Pages 1-3 were tested with Yahoo. |
| `autocomplete: bing` | Keeps autocomplete compatible with the limited inventory; the `postgres` prefix returned eleven suggestions. |
| `outgoing.request_timeout: 6.0`, `max_request_timeout: 8.0` | A bounded starting budget, measured with live engines. The explicit Crossref and Semantic Scholar timeouts match six seconds. |
| Upstream weights, categories and suspension times | Keep maintained ranking and backoff behavior; no extreme weight or suspension override is recommended. |
| `server.limiter: false` | Applies only to this private example, whose host ports bind to loopback. Public ingress needs the separate limiter and security procedure. |

A larger timeout helps a slow reachable provider; it cannot repair access
denial. Increasing every timeout also increases worst-case latency and retained
work. Change one budget at a time and measure engine errors. The
[outgoing settings](https://docs.searxng.org/admin/settings/settings_outgoing.html)
and [search settings](https://docs.searxng.org/admin/settings/settings_search.html)
explain upstream limits and backoff.

`disabled: false` does not cancel an inherited `inactive: true`. Mojeek needed
both `inactive: false` and `disabled: false` to become available. Startpage
became available with the same configuration override but then returned CAPTCHA;
activation alone is not proof that an engine works. Inspect `/config` and the
private effective settings after an upgrade; the public capability response is
not a complete private configuration dump.
[Engine settings](https://docs.searxng.org/admin/settings/settings_engines.html)
describe the distinction.

When narrowing the engine inventory, also select an autocomplete backend that
remains available. Keeping the inherited DuckDuckGo autocomplete after removing
its engine caused a search HTTP 500 in this study. The supplied Bing setting
was verified both directly and through MCP.
For Internet-facing SearXNG, follow the [ingress and limiter guide](self-hosted-searxng.md#limiter-proxy-and-security)
and [upstream limiter documentation](https://docs.searxng.org/admin/searx.limiter.html).
The included loopback recipe does not configure public authentication, TLS or
trusted proxy headers. Enabling all engines or turning off protection is not a
coverage strategy.

## Preserve information through MCP

The example sets these **profile values**, separate from the application's
[canonical defaults](../CONFIGURATION.md):

```text
SEARXNG_TIMEOUT_MS=15000
SEARXNG_DEFAULT_LANGUAGE=en-US
SEARXNG_DEFAULT_SAFESEARCH=1
SEARXNG_DEFAULT_RESPONSE_FORMAT=json
SEARCH_CACHE_TTL_MS=300000
CACHE_TTL_MS=300000
```

Fifteen seconds gives the tested upstream budgets room to finish. A five-minute
search cache balances repeat agent calls with freshness; it is a choice, not a
guarantee of fresh news. `CACHE_TTL_MS` controls a separate URL-read cache. Both
are process-local; restarting MCP clears them. Keep a shared MCP process running
so repeated calls can reuse its cache. Fresh per-call processes repeat upstream
work and can contribute to provider throttling. Their application defaults are
24 hours. Do not set a TTL to zero to disable caching: non-positive values fall
back to the default.

For broad research, leave `SEARXNG_MAX_RESULTS` and
`SEARXNG_MAX_RESULT_CHARS` unset. Leave `min_score` unset too. A SearXNG score is
a ranking value, not a calibrated relevance probability. A tested `min_score=1`
call reduced the result list to four sources.

Use this call as a baseline:

```json
{
  "name": "searxng_web_search",
  "arguments": {
    "query": "PostgreSQL EXPLAIN ANALYZE documentation",
    "language": "en-US",
    "safesearch": 1,
    "response_format": "json",
    "result_detail": "full"
  }
}
```

Omitting `num_results` returns the upstream page without a result-count ceiling
when the operator cap is also unset. The initial live call returned 31 results; the supplied filtered profile returned
18 for the PostgreSQL example. Explicit
`num_results` and `SEARXNG_MAX_RESULTS` accept only 1-20; requesting 20 does not
make an engine produce 20 sources. The smaller effective caller/operator limit
wins. Snippet caps preserve URLs and titles but discard context.

Full JSON preserves answers, infoboxes, corrections, suggestions, engine errors
and specialist result fields. In the live tests, Wikipedia/Wikidata returned
zero ordinary results and one infobox; compact mode discarded that infobox.
Paper output retained DOI/authors/PDF links, repository output retained source
and license fields, and image output retained image URLs. Choose compact output
only when that information is unnecessary.

## Route the query to the source type

First call `searxng_instance_info` with `includeEngines=true`,
`includeDisabled=true`, `refresh=true`. Then select exact names available on
your instance. The following routes were exercised through the actual MCP
protocol with full JSON:

| Task | `engines` value | Tested query and useful output |
|---|---|---|
| General, technical and product discovery | `yahoo,bing,mojeek` | English/moderate-safe-search comparison, including official documentation and used-product discovery. |
| Additional query-only web sources | `yahoo,bing,duckduckgo web` | Ten-query unfiltered comparison; explicitly set `language="all"`, `safesearch=0`, and omit `time_range`. |
| Papers | `arxiv,crossref,semantic scholar` | `retrieval augmented generation evaluation`: paper links and structured bibliographic fields. |
| Biomedical / battery literature | `pubmed,crossref` | `lithium iron phosphate battery recycling`: literature records; read the papers to assess relevance. |
| News | `bing news,duckduckgo news` | `NASA Artemis mission`: news sources with available publication metadata. |
| Repositories | `github` | `searxng`: repository links and source metadata. |
| Programming discussions | `stackoverflow` | `postgresql explain analyze`: discussion links; validate against official documentation. |
| Entity facts | `wikipedia,wikidata` | `heat pump`: infobox rather than a normal result list. |
| Images | `bing images` | `James Webb telescope`: image URL fields; search availability does not grant reuse rights. |

For example, add `"engines": "arxiv,crossref,semantic scholar"` to the call
above and change the query. Engines already determine the relevant category;
avoid imposing an incompatible category alongside them. Use `categories` when
you want the instance's category selection instead of an exact engine list.

Filter support differs by backend. `time_range="year"` worked with Yahoo.
`duckduckgo web` advertises no language, safe-search or time-range support; a
filtered call can be rejected or skip it. It is disabled by default in the
provided overlay but can be selected explicitly for query-only discovery:

```json
{
  "name": "searxng_web_search",
  "arguments": {
    "query": "PostgreSQL EXPLAIN ANALYZE documentation",
    "engines": "yahoo,bing,duckduckgo web",
    "language": "all",
    "safesearch": 0,
    "response_format": "json",
    "result_detail": "full"
  }
}
```

This route requests no language, safety or date restriction. Use the filtered
profile when those controls matter. Do not combine Mojeek into this unfiltered
route: its `safe=0` request returned HTTP 403 in the test. The exact reason was
not established. Inspect capabilities and engine errors before changing filters;
do not present unsupported filters as working controls. The
[search API](https://docs.searxng.org/dev/search_api.html) defines request parameters.

## Gather another page when necessary

Repeat the same call with `pageno=2`, then `pageno=3`, preserving the query and
filters, and use engines that advertise paging. With `engines="yahoo"`, the
tested pages 1-3 returned seven URLs each and 21 distinct URLs in total. An
earlier DuckDuckGo/Yahoo pass found 40 distinct URLs, but DuckDuckGo
later returned CAPTCHA and is excluded from the final default profile. Later
pages can overlap or be unsupported; stop when they add no useful sources or
report errors.

Combine results in the client and deduplicate by canonical URL. For the
published measurements we removed fragments and common tracking parameters
(`utm_*`, `msockid`, `gclid`, `fbclid`, `yclid`, `ref`, `ref_`), sorted remaining
query parameters and normalized host/trailing slash. This measurement method
is separate from MCP's built-in deduplication. Do not strip functional query
parameters blindly in an application.

Search query refinements can complement paging: use the model number, a more
specific technical phrase or the publisher's name, then inspect the returned
sources. Marketplace results are discovery links; they do not verify current
stock, condition, shipping or price. The profile needed no upstream product
engine rewrite.

One MCP call currently fetches one upstream page. This guide does not recommend
replica fan-out, automatic parallel paging, proxy rotation or persistent browser
sessions as a tested coverage improvement. Those require separate evidence and
capacity/privacy decisions.

## Verify before and after

1. Record the SearXNG version/image digest, MCP version/source commit, enabled
   engines, effective timeout/filter settings and cache lifetimes. Back up
   private settings securely before editing; do not export secrets in a report.
2. Run `/config`, then a direct JSON search at low rate. The deployment guide
   has [executable checks](browser-solver-deployment.md#check-readiness-and-results).
   A healthy process can still have broken DNS or failing providers.
3. Run the same query and filters through MCP. Compare result counts, infoboxes,
   result fields and `unresponsive_engines`. Use a fresh process or allow the
   configured result cache to expire after changing upstream settings.
4. Use a small fixed set covering your real tasks. Space queries by at least
   five seconds for this manual comparison; this is not an upstream rate-limit
   allowance. Stop and respect backoff on 429/CAPTCHA.
5. Review the first few sources manually for relevance, diversity, authority and
   usable content. Record median latency, errors and additional distinct URLs.
   Keyword matches and provider hit-count estimates are not quality scores.
6. Adopt a change only if the result meets your needs without unacceptable
   errors or latency. Repeat after image upgrades or an upstream provider change.

Do not copy an old successful engine list without rechecking it. The dated
[exclusion table](search-configuration-verification.md#excluded-candidates)
records failed and unsuitable candidates so they do not enter the recommended
profile unnoticed.
