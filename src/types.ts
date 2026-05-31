import { Tool } from "@modelcontextprotocol/sdk/types.js";

export interface SearXNGWeb {
  results: Array<{
    title: string;
    content: string;
    url: string;
    score: number;
  }>;
}

export interface SearXNGInstanceEngine {
  categories?: string[];
  enabled?: boolean;
  name?: string;
  shortcut?: string;
}

export interface SearXNGInstancePlugin {
  enabled?: boolean;
  name?: string;
}

export interface SearXNGInstanceConfig {
  autocomplete?: string;
  categories?: string[];
  default_locale?: string;
  default_theme?: string;
  engines?: SearXNGInstanceEngine[];
  instance_name?: string;
  locales?: Record<string, string>;
  plugins?: SearXNGInstancePlugin[];
  safe_search?: number;
}

export interface SearXNGInstanceInfoArgs {
  includeEngines?: boolean;
  includeDisabled?: boolean;
  category?: string;
}

export function isSearXNGInstanceInfoArgs(
  args: unknown
): args is SearXNGInstanceInfoArgs | undefined {
  if (args === undefined) {
    return true;
  }

  if (typeof args !== "object" || args === null) {
    return false;
  }

  const typedArgs = args as Record<string, unknown>;

  if (
    typedArgs.includeEngines !== undefined &&
    typeof typedArgs.includeEngines !== "boolean"
  ) {
    return false;
  }

  if (
    typedArgs.includeDisabled !== undefined &&
    typeof typedArgs.includeDisabled !== "boolean"
  ) {
    return false;
  }

  if (typedArgs.category !== undefined) {
    if (typeof typedArgs.category !== "string") {
      return false;
    }

    if (typedArgs.category.trim() === "") {
      return false;
    }
  }

  return true;
}

export const INSTANCE_INFO_TOOL: Tool = {
  name: "searxng_instance_info",
  description:
    "INSTANCE DISCOVERY — query the SearXNG instance for its live configuration, supported engines, categories, and plugins. " +
    "USE THIS WHEN: You need to know WHAT the instance supports before searching — especially for engine-specific or category-specific queries. " +
    "RETURNS: Instance name, default locale, safe search level, autocomplete status, all categories (31+), locales (60+), engines (60-250+), and plugins." +
    "\n\nBEST PRACTICES:" +
    "\n- Call this FIRST if you're unsure which engines are available." +
    "\n- Use `category: 'news'` to see only news-capable engines before searching news." +
    "\n- Use `includeEngines: true` with a category to get exact engine names for the `engines` parameter in web_search." +
    "\n- Use `includeDisabled: true` to see all engines including offline ones.",
  annotations: {
    readOnlyHint: true,
    openWorldHint: true,
  },
  inputSchema: {
    type: "object",
    properties: {
      includeEngines: {
        type: "boolean",
        description:
          "Include full engine details (name, shortcut, categories, status). Defaults to false for a compact response.",
        default: false,
      },
      includeDisabled: {
        type: "boolean",
        description:
          "Include disabled/offline engines in the list. Useful for debugging or capacity planning. Defaults to false.",
        default: false,
      },
      category: {
        type: "string",
        description:
          "Filter engines by category (e.g., 'general', 'news', 'images', 'videos'). Automatically enables engine details for matching engines.",
      },
    },
  },
};

export function isSearXNGWebSearchArgs(args: unknown): args is {
  query: string;
  pageno?: number;
  time_range?: string;
  language?: string;
  safesearch?: number;
  engines?: string[];
  categories?: string[];
} {
  return (
    typeof args === "object" &&
    args !== null &&
    "query" in args &&
    typeof (args as { query: string }).query === "string" &&
    (args as { query: string }).query.trim().length > 0
  );
}

export const WEB_SEARCH_TOOL: Tool = {
  name: "searxng_web_search",
  description:
    "SEARCH THE WEB — your primary tool for finding real-time information from the internet. " +
    "USE THIS WHEN: You need current facts, data, news, documentation, or any information not in your training data. " +
    "ALWAYS prefer this over guessing — web search gives you ACCURATE, UP-TO-DATE answers. " +
    "\n\nCRITICAL RULES (violating these WILL cause errors):" +
    "\n1. The parameter name MUST be exactly `query` — NOT `prompt`, NOT `q`, NOT anything else." +
    "\n2. The `query` parameter MUST be a non-empty string — empty or whitespace-only queries are REJECTED." +
    "\n3. SearXNG does NOT support `site:` operator — for domain-specific searches, use the `engines` parameter instead (e.g., engines: ['google'])." +
    "\n4. When using `engines`, pass an array like ['google', 'bing'] — NOT a comma-separated string." +
    "\n5. Setting `language` may return FEWER results if the SearXNG instance lacks engines for that language." +
    "\n\nBEST PRACTICES:" +
    "\n- Start with a simple query — add filters only if needed." +
    "\n- Use `time_range: 'month'` for recent events, `'year'` for this year's info." +
    "\n- Use `categories: ['news']` for breaking news, `['images']` for visual content." +
    "\n- For research, prefer `searxng_multi_search` to query multiple angles simultaneously.",
  annotations: {
    readOnlyHint: true,
    openWorldHint: true,
  },
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "REQUIRED: Your search query. Must be non-empty. Examples: 'latest AI benchmarks 2025', 'Python asyncio tutorial', 'CVE-2025-1234'. " +
          "DO NOT use 'prompt' or 'q' as the parameter name — use EXACTLY 'query'.",
      },
      pageno: {
        type: "number",
        description: "Page number for pagination (starts at 1). Use for deep research — page 1 has the best results.",
        default: 1,
      },
      time_range: {
        type: "string",
        description: "Filter by time: 'day' (last 24h), 'month' (last 30 days), 'year' (last 12 months). Omit for all-time results.",
        enum: ["day", "month", "year"],
      },
      language: {
        type: "string",
        description:
          "Language code (e.g., 'en', 'fr', 'de', 'ru'). Default: 'all' (all languages). " +
          "WARNING: Setting a specific language may SIGNIFICANTLY reduce results if the instance doesn't have engines for that language.",
        default: "all",
      },
      safesearch: {
        type: "number",
        description: "Safe search: 0=None (default), 1=Moderate, 2=Strict",
        enum: [0, 1, 2],
        default: 0,
      },
      engines: {
        type: "array",
        items: { type: "string" },
        description:
          "Target specific search engines (array of strings). Examples: ['google'], ['bing', 'duckduckgo'], ['wikipedia']. " +
          "Available engines: google, bing, duckduckgo, yandex, wikipedia, brave, qwant, mojeek, etc. " +
          "Without this parameter, the instance's default engines are used.",
      },
      categories: {
        type: "array",
        items: { type: "string" },
        description:
          "Filter by category (array of strings). Examples: ['general'], ['news'], ['images'], ['videos', 'news']. " +
          "Available: general, images, videos, news, music, files, it, science, social media, etc.",
      },
    },
    required: ["query"],
  },
};

export const READ_URL_TOOL: Tool = {
  name: "web_url_read",
  description:
    "READ ANY URL — fetches a web page and converts it to clean Markdown for easy reading. " +
    "USE THIS WHEN: You have a URL from search results or know a specific page you need to read. " +
    "ALWAYS use this after `searxng_web_search` to deep-dive into promising results. " +
    "\n\nRULES:" +
    "\n1. The `url` parameter MUST be a valid HTTP/HTTPS URL — other protocols are BLOCKED for security." +
    "\n2. Private/internal URLs (localhost, 127.0.0.1, 192.168.x.x) are BLOCKED by default (SSRF protection)." +
    "\n3. For large pages, use `maxLength` to avoid reading unnecessary content." +
    "\n\nBEST PRACTICES:" +
    "\n- After web search, read the top 2-3 result URLs to find the best information." +
    "\n- Use `section` to extract only the relevant heading (e.g., section: 'Installation')." +
    "\n- Use `readHeadings: true` to quickly scan page structure before reading full content." +
    "\n- Use `paragraphRange: '1-5'` to read just the introduction/summary." +
    "\n- Use `maxLength: 5000` to limit output for quick skimming.",
  annotations: {
    readOnlyHint: true,
    openWorldHint: true,
  },
  inputSchema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "The URL to read. Must be http:// or https://. Example: 'https://docs.python.org/3/asyncio.html'",
      },
      startChar: {
        type: "number",
        description: "Start reading from this character position (default: 0). Useful for pagination of large pages.",
        minimum: 0,
      },
      maxLength: {
        type: "number",
        description: "Maximum characters to return. Use 3000-5000 for summaries, 10000+ for full articles.",
        minimum: 1,
      },
      section: {
        type: "string",
        description: "Extract only the content under a specific heading. Example: 'Getting Started' or 'API Reference'.",
      },
      paragraphRange: {
        type: "string",
        description: "Return specific paragraphs. Formats: '3' (single), '1-5' (range), '10-' (from 10 to end).",
      },
      readHeadings: {
        type: "boolean",
        description: "If true, return ONLY the list of headings (table of contents) — great for quick page structure scan.",
      },
    },
    required: ["url"],
  },
};

export function isSearXNGMultiSearchArgs(args: unknown): args is {
  queries: string[];
  pageno?: number;
  time_range?: string;
  language?: string;
  safesearch?: number;
  engines?: string[];
  categories?: string[];
} {
  const queries = (args as { queries: string[] }).queries;
  return (
    typeof args === "object" &&
    args !== null &&
    "queries" in args &&
    Array.isArray(queries) &&
    queries.length > 0 &&
    queries.length <= 5 &&
    queries.every(q => typeof q === "string" && q.trim().length > 0)
  );
}

export const MULTI_SEARCH_TOOL: Tool = {
  name: "searxng_multi_search",
  description:
    "MULTI-SEARCH — fire up to 5 queries in PARALLEL and get aggregated results in one shot. " +
    "USE THIS WHEN: You need to research a topic from multiple angles, compare information, or save time on batch searches. " +
    "THIS IS 3-5x FASTER than making separate web_search calls sequentially. " +
    "\n\nRULES:" +
    "\n1. The `queries` parameter MUST be an array of 1-5 non-empty strings." +
    "\n2. Each query is fired with a 100ms stagger to avoid CAPTCHA/rate limits." +
    "\n3. Results are aggregated with per-query sections for easy comparison." +
    "\n\nBEST PRACTICES:" +
    "\n- Use different phrasings of the same topic for comprehensive coverage." +
    "\n- Example: ['AI model benchmarks 2025', 'LLM comparison chart', 'Claude vs GPT performance']." +
    "\n- For competitive analysis: ['ProductX pricing', 'ProductY pricing', 'ProductZ reviews']." +
    "\n- For fact-checking: ['claim topic pro', 'claim topic con', 'claim topic fact-check']." +
    "\n- Max 5 queries — for more, batch them into multiple calls.",
  annotations: {
    readOnlyHint: true,
    openWorldHint: true,
  },
  inputSchema: {
    type: "object",
    properties: {
      queries: {
        type: "array",
        items: { type: "string" },
        description:
          "REQUIRED: Array of 1-5 search queries to execute in parallel. " +
          "Example: ['query1', 'query2', 'query3']. Each must be a non-empty string.",
        minItems: 1,
        maxItems: 5,
      },
      pageno: {
        type: "number",
        description: "Page number for pagination (starts at 1). Applied to ALL queries.",
        default: 1,
      },
      time_range: {
        type: "string",
        description: "Filter by time (applied to ALL queries): 'day', 'month', 'year'.",
        enum: ["day", "month", "year"],
      },
      language: {
        type: "string",
        description: "Language code (applied to ALL queries). Default: 'all'. WARNING: May reduce results.",
        default: "all",
      },
      safesearch: {
        type: "number",
        description: "Safe search: 0=None (default), 1=Moderate, 2=Strict",
        enum: [0, 1, 2],
        default: 0,
      },
      engines: {
        type: "array",
        items: { type: "string" },
        description:
          "Target specific engines (applied to ALL queries). " +
          "Example: ['google', 'bing']. Available: google, bing, duckduckgo, yandex, wikipedia, etc.",
      },
      categories: {
        type: "array",
        items: { type: "string" },
        description:
          "Filter by category (applied to ALL queries). " +
          "Example: ['general'], ['news']. Available: general, images, videos, news, etc.",
      },
    },
    required: ["queries"],
  },
};
