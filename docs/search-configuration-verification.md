# Search configuration verification: 2026-10-04

These are live observations from one controlled Linux amd64 host and public
queries. SearXNG used the official image without source patches; MCP was built
from the current source. Mojeek and DuckDuckGo web remain disabled by default
in the final overlay and are used only by the documented explicit routes. The final [settings](examples/search-stack/settings/settings.yml)
and [Compose files](examples/search-stack/compose.yml) were exercised on that
host. This report is a dated starting point, not a permanent provider or
protected-site compatibility promise.

## Versions and method

| Component | Verified reference |
|---|---|
| MCP | 2.5.0, source `bfe400fd0c0be20fea156713217ea87d3f3942c6`, built with the repository Dockerfile |
| SearXNG | `2026.10.4-44b98e610`, manifest `sha256:2ddcbc64e1b96cd4c73fce2e0ddd9351f0c405d3282bed7dcbc27a4905f0811e` |
| Valkey | `8-alpine`, manifest `sha256:77643d152547b446fc15cbafaff22004545663fcd40c6b28038ad283837baa75` |
| FlareSolverr | 3.5.2, manifest `sha256:c80ae007ce2ccdcd217a12426e4f039ef763ff90738c808d38810c3e59323767` |
| Byparr | 3.0.4, manifest `sha256:874f719518f617d03a60e03411fc5d090647e1a877041e81f8dc965927c7deb6` |

Ten page-one queries covered heat pumps, Webb/exoplanets, MCP tools,
PostgreSQL EXPLAIN, SearXNG settings, RAG evaluation, LFP battery recycling,
Artemis, a used Dell U2415 and a used Switch OLED. Calls used English `en-US`,
moderate safe search and five-second spacing. The inherited-engine comparison
used the same SearXNG image and six/eight-second outgoing budgets as the
candidate. The existing-deployment row also retained its own overlay choices.
This is a sequential snapshot, not a randomized or statistical benchmark.

## General-search comparison

| Configuration | Nonempty queries | Raw URLs | Tracking-normalized URLs | Responses with engine errors | Median seconds |
|---|---:|---:|---:|---:|---:|
| Existing deployment overlay | 10/10 | 291 | 290 | 2/10 | 0.934 |
| Inherited upstream engine selection | 10/10 | 263 | 262 | 10/10 | 0.638 |
| Initial DDG HTML / Google CSE / Yahoo / Bing candidate | 10/10 | 295 | 287 | 0/10 | 0.717 |
| Initial four-engine repeat after DNS recovery | 10/10 | 291 | 282 | 0/10 | 0.718 |
| Google CSE / Yahoo / Bing before CSE throttling | 10/10 | 277 | 270 | 0/10 | 0.694 |
| Yahoo / Bing after removing failing providers | 10/10 | 113 | 108 | 0/10 | 0.690 |
| Mojeek alone, explicit activation, filtered | 10/10 | 100 | 100 | 0/10 | 1.503 |
| Three-engine activation trial, filtered | 10/10 | 203 | 198 | 0/10 | 0.764 |
| Final explicit Yahoo / Bing / Mojeek MCP route | 10/10 | 203 | 198 | 0/10 | 0.696 |
| Explicit Yahoo / Bing / DDG web, unfiltered MCP route | 10/10 | 131 | 124 | 0/10 | 0.683 |

The last row used `language=all`, `safesearch=0`, and no time filter; it is a
different workload from the English/moderate-safe-search rows. Counts are summed
per query, not globally distinct URLs. Normalization removes common tracking
query keys; see the [measurement definition](search-configuration.md#gather-another-page-when-necessary).
The explicit filtered route added 90 normalized URLs over Yahoo/Bing alone in
this snapshot. It returned fewer than the original inherited selection, whose
responses all included Brave engine errors. Choosing functioning providers and
useful metadata took priority over the largest raw count. Multiple engine names
do not imply independent indexes.

The initial candidate's first ten sources per query, the four-engine repeat's
first five, the Google CSE phase's first three and both final routes' first four
were manually reviewed for topical fit. Official PostgreSQL, SearXNG, NASA and
MCP documentation appeared alongside secondary and marketplace sources. The
existing overlay included off-topic Wiby hits for battery and console queries.
Mwmbl returned many broad or stale sources and one timeout in a separate ten-query
pass, so it was excluded despite a large count. This is a source-discovery check,
not validation of every page's claims, current stock or prices. Top-20 keyword
matches are recorded in the JSON as a heuristic; they do not establish accuracy.

Mojeek passed both filtered ten-query runs, then the first unfiltered request at
21:32:24Z returned HTTP 403. The mixed route was stopped; seven completed calls
all carried its access-denied/suspension diagnostic. That route is not recommended.
An interim MCP check still reported suspension. The upstream backoff was left
intact; no source, cooldown or suspension policy was modified. After the three-minute
suspension expired, fresh English/moderate-safe-search MCP calls at 21:35:43Z
through 21:36:00Z succeeded without engine errors: limits 10/20 returned 10/18,
the uncapped page returned 18, and its repeat was cached. This demonstrates
recovery for the tested filtered parameters, not a proven cause for the 403.

Sanitized per-query counts, errors, contributions and UTC timing are in the
[measurement data](search-configuration-verification.json). No private host
addresses, credentials, browser cookies or page bodies are published.

## MCP controls and specialist routes

Actual initialized HTTP MCP calls verified:

- Explicit `num_results=10` and `20` returned 10 and 20 against a page containing
  more results. Omitting it returned 31 in the initial study, 30 in the four-engine
  repeat and 28 in the earlier Google CSE phase. A separate MCP process with operator cap 10 returned ten even when the
  caller requested 20; an 80-character snippet ceiling produced at most 81
  characters including the ellipsis, without cutting titles/URLs. In the explicit
  filtered route a fresh uncapped PostgreSQL call returned 18; a caller limit
  of 20 also returned 18, because limits cannot create more upstream results.
- A DuckDuckGo/Yahoo paging pass returned 10/15/16 URLs with a union of 40.
  This was a client-side union across three sequential calls. After excluding
  DuckDuckGo, Yahoo alone returned 7/7/7 with 21 distinct URLs.
- Full scholarly JSON retained bibliographic fields; an arXiv/Crossref/Semantic
  Scholar call returned 39 sources. PubMed/Crossref returned 36, news 24-25,
  GitHub 30, Stack Overflow 10, and a fresh Bing-images-only call 35.
- Wikipedia/Wikidata returned one infobox and zero ordinary results. Compact
  JSON discarded the infobox. `min_score=1` reduced another call to four results.
- Yahoo alone accepted the year filter in the final profile (seven results).
  DuckDuckGo/Yahoo also accepted it earlier. The earlier full inventory
  correctly rejected a year filter for `duckduckgo web`, which advertised no
  time-range support. The final limited profile retains it disabled by default for explicit query-only calls.
  A final Bing-only year-filter call was also rejected; Yahoo was the tested year route.
- Identical calls returned `cached=true`. A SearXNG-only restart left an earlier
  partially degraded MCP response cached, showing why settings verification
  needs cache expiry or a fresh MCP process.
  A five-minute TTL test then returned uncached output after expiry, followed
  by `cached=true` on the immediately repeated call (30 results in both).

Semantic Scholar timed out once under its inherited shorter engine budget.
The final overlay assigns it six seconds. Fresh individual and combined paper
queries then succeeded; this transient failure is retained here rather than
hidden by the successful retry. Inspect engine error metadata on every route.

## Excluded candidates

| Candidate | Live observation | Decision |
|---|---|---|
| DuckDuckGo HTML search | Worked in paced comparisons, later returned CAPTCHA during compatibility checks | Removed from the final general profile. Its separate news backend was retested successfully. |
| Google web, Google news | Access denied; zero results | Excluded. |
| Google CSE | Worked initially; later returned 429/suspension during rapid compatibility calls and remained blocked in a paced recheck | Removed from the final profile; no suspension reset or aggressive retry recommended. |
| Brave | Too many requests, then suspended | Excluded; no aggressive retry or cooldown reduction. |
| Qwant | CAPTCHA; zero results | Excluded. |
| OpenAlex | Too many requests; zero results | Excluded. |
| DuckDuckGo images | Initial combined call succeeded, later call reported access denied | Removed from the final image route and supplied inventory; Bing images was retested alone. |
| Startpage | A disabled-only override left it inactive; an explicit `inactive: false` override exposed the engine, but a ready-instance call returned CAPTCHA | Excluded. |
| Wiby | Returned niche hits, including off-topic product/battery sources | Excluded from the broad profile. |
| Mwmbl | Tested across ten queries with DuckDuckGo web; added many broad/off-topic hits and timed out on the settings query | Excluded from the supplied broad profile despite its large raw count. |
| DuckDuckGo web with filters | No advertised language/safe-search/time-range support | Kept disabled by default; only the tested query-only route is recommended. |
| Mojeek without filters | Filtered ten-query passes worked, then the first `language=all` / `safesearch=0` call returned HTTP 403 | Do not use it in the query-only route; cause not established. |
| Shortening suspension times, extreme weights, larger pools, HTTP/2 overrides, proxy rotation | No evidence of improved useful coverage established by this study | No recommendation to change maintained defaults. |
| Multi-instance fan-out and persistent browser sessions | Not exercised as coverage improvements | No new recommended profile for these features. |

Failed engines may work elsewhere or later. Re-admit them only after fresh,
paced tests from the intended egress path; do not treat this table as a global
provider outage report.

## Deployment corrections and transport boundary

A later rebuild failed because mounting the tracked `settings/` directory let
the SearXNG entrypoint change its ownership, making it unreadable during Docker
build-context collection. The final recipe requires writable settings outside
the source checkout. With that private copy, initial build/start and a subsequent
build succeeded. The tracked template remains readable. The four configurations
were parsed again with this layout and their startup/health checks repeated.
The documented dual-to-base stop/remove/recreate sequence removed both provider
containers and left a healthy MCP process without provider endpoints.

Mojeek stays disabled by default in the final inventory. The explicit
`yahoo,bing,mojeek` route with `en-US` / safe-search `1` was rerun through MCP on
all ten queries: 203/198 URLs, no engine errors, median 0.696s. This avoids
implicitly selecting Mojeek when an ordinary caller drops the filters. Engine-less
MCP calls were also checked with `en-US` / `1` and `all` / `0`: both returned
nonempty, error-free Yahoo/Bing results, with no Mojeek contribution.

The local non-hardened HTTP mode accepted native initialization without Origin
(200), rejected an unlisted browser Origin (403), and accepted an arbitrary Host
without Origin (200). Origin checks are active, but this mode does not claim
Host enforcement or authentication. Follow the separate hardened HTTP procedure
for that boundary. Browser resource observations remain single-client only.

## Browser results and operational limits

At 20:53 UTC the unconfigured MCP reader returned 403 for the IACR PDF.
FlareSolverr then returned authentic extracted title and abstract in 23.7
seconds. Byparr's earlier read returned Firefox viewer controls mixed with
paper text, including alt-text dialogs and replacement characters. That is a
failed clean-PDF extraction despite tool success; no recommendation to use it
for clean PDF output is made. A separate runtime follow-up tracks that viewer
shape. Historical successful PDF reads in the
[older solver report](browser-solver-verification.md) are still historical.

The protected HTML target
`https://www.scrapingcourse.com/cloudflare-challenge` returned a fresh direct
403, followed by successful `You bypassed` content through each provider:
17.5 seconds for FlareSolverr and 12.8 for Byparr in the initial test. An ordinary
SearXNG documentation HTML page was read directly in 1.0 second and through
FlareSolverr in 5.8 seconds. Browser acquisition adds measurable overhead.

All four supplied Compose combinations passed configuration parsing and real
container startup/health checks. The health
checks verify Valkey, SearXNG's API, MCP's transport and the selected provider
APIs. Byparr's `/health` timed out; the example uses root/docs API liveness plus
an actual MCP browser read. Cold startup temporarily failed DNS resolution in
the SearXNG container and three first searches failed; direct container DNS/
HTTPS checks succeeded after recovery, then the ten-query repeat passed.
Container health alone did not establish search readiness.

The final supplied Flare-only mode returned protected HTML after a direct 403
at 21:04:31Z in 18.5 seconds and clean PDF text in 21.8 seconds. Byparr-only
returned protected HTML after a direct 403 at 21:06:11Z in 16.3 seconds; its PDF
read reproduced the viewer-UI problem. With both endpoints configured and the
task's FlareSolverr stopped, a fresh direct GET returned 403 at 21:08:35Z; MCP
then returned the successful marker through Byparr in 12.5 seconds. The primary
was restarted afterward. Byparr also returned ordinary documentation HTML.

Two repository live compatibility runs each had two compact-output test
failures. Their assertions assume an error-free engine response: compact text
requires three lines per record and compact JSON expects only a `results` key.
The first run encountered a DuckDuckGo CAPTCHA warning; the second encountered
Google CSE 429/suspension warnings. Current MCP correctly preserved those engine
warnings. No assertion was weakened. Lint, build and coverage passed in those
runs; the complete local regression suite passed separately with the optional
live environment unset. The paced configuration measurements and actual MCP
calls are the live evidence reported here. A local green suite does not erase
the recorded live test failures or prove provider reliability.

Resource-limited single-client observations showed no OOM or unexpected restart.
This does not establish multi-user capacity, sustained browser memory peaks,
proxy/TLS deployments, ARM64 behavior, every engine filter or every protected
target. The recommended optional browser modes are based on successful HTML
content reads, with the PDF exception explicit.
