import { Tool } from "@modelcontextprotocol/sdk/types.js";

export interface SearXNGWebResult {
  title: string;
  content: string;
  url: string;
  score: number;
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
  suggestions?: string[];
  corrections?: string[];
  answers?: string[];
  infoboxes?: SearXNGWebInfobox[];
  unresponsive_engines?: Array<[string, string]>;
}

const VALID_TIME_RANGES = ["day", "week", "month", "year"] as const;
const VALID_SAFESEARCH_VALUES = [0, 1, 2] as const;

export function isSearXNGWebSearchArgs(args: unknown): args is {
  query: string;
  pageno?: number;
  time_range?: string;
  language?: string;
  safesearch?: number;
  min_score?: number;
  num_results?: number;
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
    },
    required: ["query"],
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
