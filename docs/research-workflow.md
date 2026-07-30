# Evidence-Focused Research Workflow

Use this client-neutral workflow when an agent must support an answer with
traceable evidence. It composes the four mcp-searxng tools without requiring
every tool on every task.

## Choose the tool that advances the task

- Use `searxng_web_search` when the source URL is unknown or you need to
  discover several perspectives.
- Use `searxng_search_suggestions` only when a query is vague, incomplete, or
  uses uncertain terminology. Skip it when the query is already precise.
- Use `searxng_instance_info` only when available categories, engines, locales,
  or instance defaults affect the search. It reports the configured
  instances' current capabilities; it does not expand them.
- Use `web_url_read` after selecting a known URL whose page content is needed.
  A search-result snippet is discovery evidence, not a substitute for reading
  a source that supports a material claim.

## Bounded workflow

### 1. Define the information need

Write the question, intended audience, required freshness, and what would count
as sufficient evidence. Separate factual claims from opinions, forecasts, or
decisions. Record material constraints such as language, jurisdiction, date
range, and acceptable source types.

### 2. Inspect capabilities only when needed

Call `searxng_instance_info` when the plan depends on a category or engine, or
when a search behaves differently than expected. In full mode:

- `includeEngines` includes enabled engine names.
- `includeDisabled` also includes disabled engines when `includeEngines` is
  true.
- `category` narrows the capability response to one category.
- `refresh` bypasses the process cache and fetches current `/config` data.

For multiple configured instances, prefer common capabilities for consistent
behavior. Available-only capabilities may work on some instances and not
others.

### 3. Refine an ambiguous query

If terminology is unclear, use `searxng_search_suggestions` with `query` and,
when useful, `language`. Treat suggestions as query ideas, not evidence.
Otherwise proceed directly to search.

Useful refinements include:

- Terminology: add the exact product, standard, error, organization, or quoted
  phrase.
- Language: use `language` for a known locale, or broaden to `all`.
- Freshness: use `time_range` (`day`, `week`, `month`, or `year`) only when the
  question requires it.
- Scope: use `categories` or `engines` only after confirming the instance
  supports the intended values.
- Precision: add a jurisdiction, version, date, domain, or primary-source
  organization.

### 4. Search, then adjust deliberately

Call `searxng_web_search` with the required `query`. Full mode also supports:

- `pageno` for later result pages.
- `time_range`, `language`, and `safesearch` for scope.
- `min_score` and `num_results` for result selection.
- `categories` and `engines` for instance-supported routing.
- `response_format` as `text` for normal agent use or `json` for structured
  processing.

If results are poor or empty, change one material constraint at a time:

1. remove unnecessary words or try a recognized synonym;
2. remove an overly restrictive `time_range`;
3. broaden `language` to `all`;
4. remove narrow `categories` or `engines`;
5. broaden the question, then search a narrower sub-question separately.

Retries do not ensure useful results. Engine access, rate limits, and result
quality remain instance-dependent.

### 5. Select sources before reading pages

Prefer sources that are relevant, attributable, current enough for the claim,
and close to the underlying evidence. For material factual claims, favor
primary sources such as official documentation, laws, standards, datasets,
research papers, and first-party announcements. Use independent secondary
sources to add context or challenge a primary source's interpretation.

Do not count syndicated copies, articles repeating one announcement, or several
pages from the same organization as independent confirmation.

### 6. Read the evidence

Use `web_url_read` with `url` for each selected page. In full mode:

- use `startChar` and `maxLength` to paginate long content;
- use `section` for a known heading;
- use `paragraphRange` for a narrow passage;
- use `readHeadings` to inspect structure before choosing a section.

If a page is unavailable, binary, unsupported, or too incomplete to support the
claim, choose another source. Do not infer that a search snippet proves what the
unread page contains.

### 7. Cross-check material claims

Cross-check material claims against another genuinely independent source, or
explain why only one authoritative source exists. Compare dates, versions,
definitions, population or sample, and measurement method. When sources
conflict, report the disagreement and determine whether freshness, scope, or
method explains it; do not silently choose the convenient result.

### 8. Cite the evidence and state uncertainty

Cite the evidence next to the claim it supports, using the source's canonical
URL when available. Distinguish direct source statements from your synthesis.

#### Evidence versus inference

- Evidence: what a cited source directly establishes.
- Inference: a conclusion drawn by combining evidence or filling a stated gap.
- Unknown: information the available sources do not establish.

State uncertainty when evidence is incomplete, stale, contradictory, or based
on an inference. Never invent a citation, quotation, date, or source detail.

## Adjustable budgets

Use this as an adjustable starting point, then reduce or increase it according
to risk and task complexity:

| Work | Small factual check | Normal research | High-impact claim |
| --- | ---: | ---: | ---: |
| Search rounds | 1 | 2-3 | 3-5 |
| Search calls per round | 1 | 1-2 | 2-3 |
| Pages read | 1-2 | 3-6 | 5-10 |
| Concurrent calls | 1-2 | 2-4 | 2-4 |

Parallel calls should cover independent queries or sources. Keep dependent
steps sequential: discover a URL before reading it, and inspect capabilities
before relying on an instance-specific category or engine.

## Stopping conditions

Stop when all of the following are true:

- the question is answered at the required level of detail;
- every material factual claim has a citation or is explicitly labeled as
  inference or unknown;
- important claims have appropriate independent confirmation;
- remaining source disagreement and uncertainty are stated;
- another search round is unlikely to change the conclusion materially.

Stop earlier when the agreed call or time budget is reached, access is blocked,
or available evidence cannot answer the question. Report the limitation instead
of continuing unbounded retries. No fixed budget or workflow can ensure
complete, current, or correct search results.

## Privacy and sensitive queries

Queries and fetched URLs are sent to the configured SearXNG service and,
depending on its configuration, upstream engines and destination sites. Do not
submit secrets, credentials, private identifiers, confidential text, or
unnecessary personal data. A public instance adds an operator trust boundary;
self-hosting improves control but does not by itself make upstream activity
anonymous.

Use the [self-hosted operator guide](self-hosted-searxng.md) when you control
the SearXNG deployment. Use the
[public-instance guide](public-searxng-instances.md) when you do not.

## Lite Tools Mode

With `SEARXNG_LITE_TOOLS=true`, the tool schemas intentionally save context:
search and suggestions accept only `query`, instance information accepts no
optional controls, and URL reading accepts only `url`. The workflow still
applies, but parameter-based refinement and selective page extraction require
full mode. Do not send full-mode parameters and assume they were honored.

