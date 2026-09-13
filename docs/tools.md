# Search and read with mcp-searxng

Connect your [MCP client](client-configurations.md) first. These examples show
tool names and arguments; your client may display a server prefix or group.

| Task | Tool |
|---|---|
| Find sources | `searxng_web_search` |
| Refine an incomplete query | `searxng_search_suggestions` |
| Check available engines/categories | `searxng_instance_info` |
| Read a selected source | `web_url_read` |

## First search and source read

Call `searxng_web_search`:

```json
{"query":"SearXNG documentation","num_results":3}
```

Choose a relevant URL from the results, then call `web_url_read` with that URL.
This example uses a placeholder; replace it with the source you selected:

```json
{"url":"https://example.com/article","maxLength":4000}
```

For a long page, request `readHeadings=true` first, then use `section` or
`startChar`/`maxLength` on a separate call. Headings-only mode cannot be
combined with the other extraction controls. PDF reading extracts text, not OCR.

Start without engine/time filters, then refine only when needed. Use full
output while troubleshooting; compact output intentionally omits metadata.
An empty response is not proof that every engine was healthy. See
[result quality and cache](troubleshooting.md#result-quality-and-cache).

## searxng_web_search
  - Execute web searches with pagination
  - Inputs:
    - `query` (string): The search query. This string is passed to external search services.
    - `pageno` (number, optional): Search page number, starts at 1 (default 1)
    - `time_range` (string, optional): Filter results by time range - one of: "day", "week", "month", "year" (default: none)
    - `language` (string, optional): Language code for results (e.g., "en", "fr", "de") or "all" (default: "all")
    - `safesearch` (string enum, optional): Safe search filter level, one of `"0"` (None), `"1"` (Moderate), or `"2"` (Strict). Legacy numeric values `0`, `1`, and `2` are still accepted for backward compatibility. (default: instance setting)
    - `min_score` (number, optional): Minimum relevance score from 0.0 to 1.0. Results below this score are filtered out.
    - `num_results` (number, optional): Maximum number of results to return, from 1 to 20. `SEARXNG_MAX_RESULTS` applies as an operator ceiling.
    - `categories` (string, optional): Comma-separated SearXNG categories (e.g. `"news"`, `"it,science"`). Live `/config` capabilities are aggregated across reachable instances; prefer `searxng_instance_info` `categories.common` for consistent multi-instance results. Known values are trimmed and normalized case-insensitively; unknown values are forwarded trimmed so SearXNG can ignore or honor them. If `/config` is unavailable, values are forwarded as-is with a warning. If omitted, each instance uses its server-side default.
    - `engines` (string, optional): Comma-separated SearXNG engine names (e.g. `"google,bing,ddg"`, `"semantic scholar"`). Live `/config` capabilities are aggregated across reachable instances; prefer `searxng_instance_info` `engines.common.enabled` for consistent multi-instance results. Known values are trimmed and normalized case-insensitively, including engines disabled by default; unknown values are forwarded trimmed so SearXNG can ignore or honor them. If `/config` is unavailable, values are forwarded as-is with a warning, except when combined with `time_range`.
    - When `engines` and `time_range` are both provided, every configured SearXNG instance must return `/config` successfully and every selected engine must explicitly report `time_range_support=true`. If any instance is unreachable or any engine is unsupported or unknown, the request fails before `/search` to avoid a misleading empty result. Omit `time_range` or use an engine-specific query filter instead.
    - `response_format` (string, optional): Response format, either `"text"` for formatted agent-readable output or `"json"` for raw SearXNG JSON with filtered/sliced `results`. If omitted, `SEARXNG_DEFAULT_RESPONSE_FORMAT` applies; if unset or invalid, `text` is used. An explicit `response_format` always takes precedence.
    - `result_detail` (string, optional): `"full"` (the default) preserves SearXNG metadata, warnings, provenance, answers, infoboxes, corrections, and suggestions. `"compact"` returns only title, URL, and the description/content snippet for every result; compact JSON uses exactly the `title`, `url`, and `content` keys. Use full when those research signals matter.
    - Clients that explicitly send or auto-inject `response_format=text` continue to override the operator default. If omitted calls still return text after configuring JSON, inspect the arguments emitted by the MCP client.

  Migration: compact text has exactly three lines per result and no cache annotation or preamble. Update line parsers that expect relevance scores or search metadata to request `result_detail="full"` (or accept compact's three-line records).

  Compact deliberately suppresses warnings, provenance, and every other search signal. Full text may add valid optional lines in fixed order: score, engines, category, published date, thumbnail, image source; invalid optional metadata is omitted. Text fields are normalized to single lines. `SEARXNG_MAX_RESULT_CHARS` truncates result content in compact and full text/JSON responses, including full JSON for existing users who already set the variable; compact text normalizes line separators before applying the cap, while JSON caps the original string value.

  With `SEARXNG_LITE_TOOLS=true`, the Lite schema stays query-only, but explicitly supplied optional overrides such as `response_format` and `result_detail` are still validated and honored.

## searxng_search_suggestions
  - Get autocomplete suggestions for refining search queries
  - Inputs:
    - `query` (string): Partial or complete query to autocomplete.
    - `language` (string, optional): Language code for suggestions (e.g., "en", "fr", "de") or "all" (default: "all")

## searxng_instance_info
  - Discover categories aggregated from reachable configured SearXNG instances, optionally include engine names, and inspect defaults, locales, and plugins from the primary reachable instance. Categories—and engines when requested—report `common` values present on every reachable instance and `available` values present on at least one reachable instance.
  - Inputs:
    - `includeEngines` (boolean, optional): Include enabled engine names in the response. (default: false)
    - `includeDisabled` (boolean, optional): Include disabled engine names when `includeEngines` is true. (default: false)
    - `category` (string, optional): Filter categories and engines to a single category name.
    - `refresh` (boolean, optional): Bypass the process cache and fetch fresh `/config` data. (default: false)

## web_url_read
  - Read URL content as markdown with content-type-aware handling and advanced extraction options
  - Supported readable content:
    - HTML (`text/html`, `application/xhtml+xml`) is converted to markdown
    - JSON (`application/json`, `*+json`) is pretty-printed in a fenced block
    - Plain text, YAML, TOML, XML, and other safe explicit `text/*` responses are returned as readable fenced text
    - PDF (`application/pdf`) text is extracted in a resource-bounded worker for documents up to 500 pages
    - Missing or generic content types are read under the existing size cap; non-binary bodies continue through the HTML-to-markdown path for compatibility
  - PDF input and extracted text are each capped at the lower of `URL_READ_MAX_CONTENT_LENGTH_BYTES` and 16 MiB. OCR is not supported, and scanned/image-only or password-protected PDFs return a short explanation.
  - A response declared as PDF must begin with the `%PDF-` signature; a mismatch usually indicates an interstitial or error page served with the wrong content type.
  - PDF parsing has a separate 30-second worker budget after the response body is downloaded. On the direct path, the network fetch and parse take at most the configured fetch budget plus 30 seconds; configured browser-solver preflight and acquisition time is additional.
  - At most two PDF extractions run concurrently per MCP process. There is no queue; additional concurrent reads return a busy message and may be retried.
  - Other binary, media, archive, and octet-stream downloads are intentionally rejected with a short hint instead of returning raw bytes
  - When `FLARESOLVERR_URL` or `BYPARR_URL` is configured, an uncached URL is validated and checked by the HEAD size preflight before `mcp-searxng` attempts browser-session acquisition. With both set, FlareSolverr is attempted first and Byparr is attempted only after a busy slot, network/timeout failure, HTTP 408/429/5xx, or malformed/oversized response. Persistent provider 4xx, cancellation, solution-host validation failure, and solved non-2xx target status stop the chain. If every configured provider is busy or unavailable, one uncached direct fetch runs. Each attempted provider receives the original target URL; challenge success is not guaranteed.
  - At default limits, dual-provider stage budgets total 143 seconds before PDF parsing: a 3-second initial HEAD preflight, two 65-second solver attempts (including response grace), and a 10-second final fetch. PDF parsing can add 30 seconds. These are cancellation budgets, not a precise wall-clock guarantee; see [URL Reader Controls](../CONFIGURATION.md#url-reader-controls).
  - Inputs:
    - `url` (string): The URL to fetch and process
    - `startChar` (number, optional): Starting character position for content extraction (default: 0)
    - `maxLength` (number, optional): Maximum number of characters to return
    - `section` (string, optional): Extract content under a specific heading (searches for heading text)
    - `paragraphRange` (string, optional): Return specific paragraph ranges (e.g., '1-5', '3', '10-')
    - `readHeadings` (boolean, optional): Return only a list of headings instead of full content

## Defaults, limits and evidence

Both search and URL content use process-local caches. See
[cache behavior](troubleshooting.md#result-quality-and-cache) before interpreting
a repeated request as a new upstream check. Operator limits and defaults are in
[Configuration](../CONFIGURATION.md); explicit arguments can override defaults
but cannot exceed operator ceilings.

Browser solvers acquire cookies/user-agent for a separate target fetch; they do
not turn this tool into a general rendered-page browser. The
[solver controls](../CONFIGURATION.md#url-reader-controls) own provider order,
timeouts, caching and failure behavior. Historical provider versions and image
digests are recorded in [browser solver verification](browser-solver-verification.md).

For source selection, cross-checking and citation, use the optional
[research workflow](research-workflow.md). For errors, use
[troubleshooting](troubleshooting.md).
