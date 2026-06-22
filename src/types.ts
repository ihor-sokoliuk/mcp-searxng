import { Tool } from "@modelcontextprotocol/sdk/types.js";

export interface SearXNGWebResult {
  title: string;
  content: string;
  url: string;
  score?: number;
  engine?: string;
  engines?: string[];
  category?: string;
  publishedDate?: string;
  thumbnail?: string;
  img_src?: string;
}

export interface SearXNGWebInfobox {
  infobox: string;
  content?: string;
  urls?: Array<{ title: string; url: string }>;
}

export interface SearXNGWeb {
  query: string;
  number_of_results: number;
  results: SearXNGWebResult[];
  sourceFormat?: "json" | "html";
  suggestions?: string[];
  corrections?: string[];
  answers?: string[];
  infoboxes?: SearXNGWebInfobox[];
  unresponsive_engines?: Array<[string, string]>;
}

const VALID_TIME_RANGES = ["day", "week", "month", "year"] as const;
const VALID_SAFESEARCH_VALUES = [0, 1, 2] as const;
const VALID_RESPONSE_FORMATS = ["text", "json"] as const;

export function isSearXNGWebSearchArgs(args: unknown): args is {
  query: string;
  pageno?: number;
  time_range?: string;
  language?: string;
  safesearch?: number;
  min_score?: number;
  num_results?: number;
  categories?: string;
  engines?: string;
  response_format?: "text" | "json";
} {
  if (
    typeof args !== "object" ||
    args === null ||
    !("query" in args) ||
    typeof (args as { query: string }).query !== "string"
  ) {
    return false;
  }

  const searchArgs = args as {
    pageno?: unknown;
    time_range?: unknown;
    language?: unknown;
    safesearch?: unknown;
    min_score?: unknown;
    num_results?: unknown;
    categories?: unknown;
    engines?: unknown;
    response_format?: unknown;
  };

  if (searchArgs.pageno !== undefined && (typeof searchArgs.pageno !== "number" || searchArgs.pageno < 1)) {
    return false;
  }
  if (
    searchArgs.time_range !== undefined &&
    (typeof searchArgs.time_range !== "string" || !VALID_TIME_RANGES.includes(searchArgs.time_range as any))
  ) {
    return false;
  }
  if (searchArgs.language !== undefined && typeof searchArgs.language !== "string") {
    return false;
  }
  if (
    searchArgs.safesearch !== undefined &&
    (typeof searchArgs.safesearch !== "number" || !VALID_SAFESEARCH_VALUES.includes(searchArgs.safesearch as any))
  ) {
    return false;
  }
  if (
    searchArgs.min_score !== undefined &&
    (typeof searchArgs.min_score !== "number" ||
      Number.isNaN(searchArgs.min_score) ||
      searchArgs.min_score < 0 ||
      searchArgs.min_score > 1)
  ) {
    return false;
  }
  if (
    searchArgs.num_results !== undefined &&
    (typeof searchArgs.num_results !== "number" ||
      Number.isNaN(searchArgs.num_results) ||
      !Number.isInteger(searchArgs.num_results) ||
      searchArgs.num_results < 1 ||
      searchArgs.num_results > 20)
  ) {
    return false;
  }
  if (searchArgs.categories !== undefined && typeof searchArgs.categories !== "string") {
    return false;
  }
  if (searchArgs.engines !== undefined && typeof searchArgs.engines !== "string") {
    return false;
  }
  if (
    searchArgs.response_format !== undefined &&
    (typeof searchArgs.response_format !== "string" || !VALID_RESPONSE_FORMATS.includes(searchArgs.response_format as any))
  ) {
    return false;
  }

  return true;
}

export function isSearXNGSearchSuggestionsArgs(args: unknown): args is {
  query: string;
  language?: string;
} {
  if (
    typeof args !== "object" ||
    args === null ||
    !("query" in args) ||
    typeof (args as { query: string }).query !== "string"
  ) {
    return false;
  }

  const suggestionArgs = args as { language?: unknown };
  if (suggestionArgs.language !== undefined && typeof suggestionArgs.language !== "string") {
    return false;
  }

  return true;
}

export function isSearXNGInstanceInfoArgs(args: unknown): args is {
  includeEngines?: boolean;
  includeDisabled?: boolean;
  category?: string;
  refresh?: boolean;
} {
  if (typeof args !== "object" || args === null) {
    return false;
  }

  const infoArgs = args as {
    includeEngines?: unknown;
    includeDisabled?: unknown;
    category?: unknown;
    refresh?: unknown;
  };
  if (infoArgs.includeEngines !== undefined && typeof infoArgs.includeEngines !== "boolean") {
    return false;
  }
  if (infoArgs.includeDisabled !== undefined && typeof infoArgs.includeDisabled !== "boolean") {
    return false;
  }
  if (infoArgs.category !== undefined && typeof infoArgs.category !== "string") {
    return false;
  }
  if (infoArgs.refresh !== undefined && typeof infoArgs.refresh !== "boolean") {
    return false;
  }

  return true;
}

export const WEB_SEARCH_TOOL: Tool = {
  name: "searxng_web_search",
  description:
    "Searches the web using SearXNG and returns a list of results, each with a title, URL, and content snippet. " +
    "CRITICAL: The required parameter name is exactly `query` (not `prompt`, `q`, or any other name). " +
    "Calls an external SearXNG instance; availability depends on the `SEARXNG_URL` configuration. " +
    "Use `pageno` to paginate results; combine `time_range` and `language` to narrow scope. " +
    "To read the full text of a result URL, follow up with `web_url_read`.",
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
          "The search query string. This is the required parameter name — use exactly `query`, not `prompt` or `q`.",
      },
      pageno: {
        type: "number",
        description: "Search page number (starts at 1)",
        default: 1,
      },
      time_range: {
        type: "string",
        description: "Time range of search (day, week, month, year)",
        enum: ["day", "week", "month", "year"],
      },
      language: {
        type: "string",
        description:
          "Language code for search results (e.g., 'en', 'fr', 'de'). Default is instance-dependent.",
        default: "all",
      },
      safesearch: {
        type: "number",
        description:
          "Safe search filter level (0: None, 1: Moderate, 2: Strict)",
        enum: [0, 1, 2],
        default: 0,
      },
      min_score: {
        type: "number",
        description:
          "Minimum relevance score threshold from 0.0 to 1.0. Results below this score are filtered out.",
        minimum: 0,
        maximum: 1,
      },
      num_results: {
        type: "number",
        description:
          "Maximum number of results to return (1-20). Operator cap SEARXNG_MAX_RESULTS applies as a ceiling.",
        minimum: 1,
        maximum: 20,
      },
      categories: {
        type: "string",
        description:
          "Comma-separated SearXNG categories. Values are normalized case-insensitively to canonical names from live /config; unknown values are rejected with available categories listed. If /config is unavailable, values are forwarded as-is with a warning.",
      },
      engines: {
        type: "string",
        description:
          "Comma-separated SearXNG engine names to query (e.g. 'google,bing,ddg'). Values are normalized case-insensitively to canonical names from live /config; unknown values are rejected with available engines listed. If /config is unavailable, values are forwarded as-is with a warning.",
      },
      response_format: {
        type: "string",
        description: "Response format: formatted text for agents or raw JSON for programmatic clients. Default: text.",
        enum: ["text", "json"],
        default: "text",
      },
    },
    required: ["query"],
  },
};

export const SUGGESTIONS_TOOL: Tool = {
  name: "searxng_search_suggestions",
  description:
    "Returns autocomplete suggestions from the configured SearXNG instance. " +
    "Use this to refine vague or partial queries before searching.",
  annotations: {
    readOnlyHint: true,
    openWorldHint: true,
  },
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Partial or complete query to autocomplete.",
      },
      language: {
        type: "string",
        description: "Language code for suggestions (e.g., 'en', 'fr', 'de') or 'all'. Default: all.",
        default: "all",
      },
    },
    required: ["query"],
  },
};

export const INSTANCE_INFO_TOOL: Tool = {
  name: "searxng_instance_info",
  description:
    "Discovers capabilities from the configured SearXNG instance via /config, including categories, engines, defaults, locales, and plugins.",
  annotations: {
    readOnlyHint: true,
    openWorldHint: true,
  },
  inputSchema: {
    type: "object",
    properties: {
      includeEngines: {
        type: "boolean",
        description: "Include enabled engine names in the response.",
        default: false,
      },
      includeDisabled: {
        type: "boolean",
        description: "Include disabled engine names when includeEngines is true.",
        default: false,
      },
      category: {
        type: "string",
        description: "Filter categories and engines to a single category name.",
      },
      refresh: {
        type: "boolean",
        description: "Bypass the process cache and fetch fresh /config data.",
        default: false,
      },
    },
    required: [],
  },
};

export const LITE_WEB_SEARCH_TOOL: Tool = {
  name: "searxng_web_search",
  description: "Web search. Returns titles, URLs, snippets.",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string", description: "Search query." } },
    required: ["query"],
  },
};

export const LITE_SUGGESTIONS_TOOL: Tool = {
  name: "searxng_search_suggestions",
  description: "Autocomplete search query suggestions.",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string", description: "Query prefix." } },
    required: ["query"],
  },
};

export const LITE_INSTANCE_INFO_TOOL: Tool = {
  name: "searxng_instance_info",
  description: "Discover SearXNG instance capabilities.",
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
  },
};

export const LITE_READ_URL_TOOL: Tool = {
  name: "web_url_read",
  description: "Fetch URL. Returns page text as markdown.",
  inputSchema: {
    type: "object",
    properties: { url: { type: "string", description: "URL to fetch." } },
    required: ["url"],
  },
};

export function isReverseImageSearchArgs(args: unknown): args is {
  image_url: string;
  pageno?: number;
  engines?: string;
  categories?: string;
  time_range?: string;
  language?: string;
  safesearch?: number;
  min_score?: number;
  num_results?: number;
  response_format?: "text" | "json";
} {
  if (
    typeof args !== "object" ||
    args === null ||
    !("image_url" in args) ||
    typeof (args as { image_url: string }).image_url !== "string"
  ) {
    return false;
  }

  const imageSearchArgs = args as {
    pageno?: unknown;
    engines?: unknown;
    categories?: unknown;
    time_range?: unknown;
    language?: unknown;
    safesearch?: unknown;
    min_score?: unknown;
    num_results?: unknown;
    response_format?: unknown;
  };

  if (imageSearchArgs.pageno !== undefined && (typeof imageSearchArgs.pageno !== "number" || imageSearchArgs.pageno < 1)) return false;
  if (imageSearchArgs.engines !== undefined && typeof imageSearchArgs.engines !== "string") return false;
  if (imageSearchArgs.categories !== undefined && typeof imageSearchArgs.categories !== "string") return false;
  if (
    imageSearchArgs.time_range !== undefined &&
    (typeof imageSearchArgs.time_range !== "string" || !VALID_TIME_RANGES.includes(imageSearchArgs.time_range as any))
  ) return false;
  if (imageSearchArgs.language !== undefined && typeof imageSearchArgs.language !== "string") return false;
  if (
    imageSearchArgs.safesearch !== undefined &&
    (typeof imageSearchArgs.safesearch !== "number" || !VALID_SAFESEARCH_VALUES.includes(imageSearchArgs.safesearch as any))
  ) return false;
  if (
    imageSearchArgs.min_score !== undefined &&
    (typeof imageSearchArgs.min_score !== "number" || Number.isNaN(imageSearchArgs.min_score) || imageSearchArgs.min_score < 0 || imageSearchArgs.min_score > 1)
  ) return false;
  if (
    imageSearchArgs.num_results !== undefined &&
    (typeof imageSearchArgs.num_results !== "number" ||
      Number.isNaN(imageSearchArgs.num_results) ||
      !Number.isInteger(imageSearchArgs.num_results) ||
      imageSearchArgs.num_results < 1 ||
      imageSearchArgs.num_results > 20)
  ) return false;
  if (
    imageSearchArgs.response_format !== undefined &&
    (typeof imageSearchArgs.response_format !== "string" || !VALID_RESPONSE_FORMATS.includes(imageSearchArgs.response_format as any))
  ) return false;

  return true;
}

export const REVERSE_IMAGE_SEARCH_TOOL: Tool = {
  name: "reverse_image_search",
  description:
    "Reverse image search via SearXNG: finds web pages where a given image appears. " +
    "The input must be a direct public URL to an image (http or https). " +
    "Only 'tineye' performs true reverse image search (searching by visual content). " +
    "Other image engines such as 'google images' or 'bing images' are regular image search engines " +
    "that treat the URL as a text query — they do NOT search by image content. " +
    "Always pass `engines: \"tineye\"` for genuine reverse image search. " +
    "Note: TinEye must be enabled in the SearXNG instance settings. " +
    "Use this to discover where an image originates or where it has been published. " +
    "Follow up with `web_url_read` to read the full content of individual result URLs.",
  annotations: {
    readOnlyHint: true,
    openWorldHint: true,
  },
  inputSchema: {
    type: "object",
    properties: {
      image_url: {
        type: "string",
        description: "Direct URL of the image to look up (e.g. https://example.com/photo.jpg)",
      },
      pageno: {
        type: "number",
        description: "Results page number (starts at 1)",
        default: 1,
      },
      engines: {
        type: "string",
        description:
          "Comma-separated SearXNG engine names (default: 'tineye'). " +
          "Only 'tineye' performs true reverse image search by visual content. " +
          "Other image engines (e.g. 'google images', 'bing images') treat the URL as a text query and do NOT search by image content. " +
          "Values are normalized case-insensitively against live /config; unknown values are rejected with available engines listed. " +
          "If /config is unavailable, values are forwarded as-is with a warning.",
      },
      categories: {
        type: "string",
        description:
          "Comma-separated SearXNG categories (e.g. 'images'). " +
          "Values are normalized case-insensitively; unknown values are rejected with available categories listed.",
      },
      time_range: {
        type: "string",
        description: "Time range filter (day, week, month, year). Support varies by engine.",
        enum: ["day", "week", "month", "year"],
      },
      language: {
        type: "string",
        description: "Language code for results (e.g. 'en', 'es'). Default is instance-dependent.",
        default: "all",
      },
      safesearch: {
        type: "number",
        description: "Safe search filter level (0: None, 1: Moderate, 2: Strict)",
        enum: [0, 1, 2],
        default: 0,
      },
      min_score: {
        type: "number",
        description: "Minimum relevance score threshold (0.0–1.0). Results below this score are filtered out.",
        minimum: 0,
        maximum: 1,
      },
      num_results: {
        type: "number",
        description: "Maximum number of results to return (1–20).",
        minimum: 1,
        maximum: 20,
      },
      response_format: {
        type: "string",
        description: "Response format: formatted text for agents or raw JSON for programmatic clients. Default: text.",
        enum: ["text", "json"],
        default: "text",
      },
    },
    required: ["image_url"],
  },
};

export const LITE_REVERSE_IMAGE_SEARCH_TOOL: Tool = {
  name: "reverse_image_search",
  description: "Reverse image search via SearXNG. Use engines: \"tineye\" for true reverse image search (by visual content). Other image engines search by URL text, not image content.",
  inputSchema: {
    type: "object",
    properties: {
      image_url: { type: "string", description: "Direct URL of the image." },
      engines: { type: "string", description: "Use 'tineye' for real reverse image search." },
      num_results: { type: "number", description: "Max results (1–20)." },
      response_format: { type: "string", description: "Output format: text or json.", enum: ["text", "json"] },
    },
    required: ["image_url"],
  },
};

export const READ_URL_TOOL: Tool = {
  name: "web_url_read",
  description:
    "Fetches a URL and returns its text content converted to markdown. " +
    "Three modes: " +
    "(1) Full content — omit filtering params; use `startChar`/`maxLength` to paginate large pages. " +
    "(2) Section extraction — set `section` to return content under a specific heading. " +
    "(3) Headings only — set `readHeadings: true` to list all headings (mutually exclusive with other filtering params). " +
    "Returns an error string if the URL is unreachable or content cannot be extracted. " +
    "Use after `searxng_web_search` to read the full content of individual result URLs.",
  annotations: {
    readOnlyHint: true,
    openWorldHint: true,
  },
  inputSchema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "URL",
      },
      startChar: {
        type: "number",
        description: "Starting character position for content extraction (default: 0)",
        minimum: 0,
      },
      maxLength: {
        type: "number",
        description: "Maximum number of characters to return",
        minimum: 1,
      },
      section: {
        type: "string",
        description: "Extract content under a specific heading (searches for heading text)",
      },
      paragraphRange: {
        type: "string",
        description: "Return specific paragraph ranges (e.g., '1-5', '3', '10-')",
      },
      readHeadings: {
        type: "boolean",
        description: "Return only a list of headings instead of full content",
      },
    },
    required: ["url"],
  },
};
