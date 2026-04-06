import { Tool } from "@modelcontextprotocol/sdk/types.js";

export interface SearXNGResult {
  title?: string;
  content?: string;
  url?: string;
  score?: number;
  [key: string]: unknown;
}

export interface SearXNGResponse {
  results: SearXNGResult[];
  answers?: string[];
  suggestions?: string[];
  corrections?: string[];
  infoboxes?: Record<string, unknown>[];
  unresponsive_engines?: string[];
  number_of_results?: number;
}

export function normalizeCategories(categories: string): string {
  return categories.split(",").map(c => c.trim().toLowerCase()).filter(Boolean).join(",");
}

export function isSearXNGWebSearchArgs(args: unknown): args is {
  query: string;
  pageno?: number;
  time_range?: string;
  language?: string;
  safesearch?: number;
  categories?: string;
  response_format?: string;
} {
  if (
    typeof args !== "object" ||
    args === null ||
    !("query" in args) ||
    typeof (args as { query: string }).query !== "string"
  ) {
    return false;
  }

  const typedArgs = args as Record<string, unknown>;
  if (typedArgs.categories !== undefined) {
    if (typeof typedArgs.categories !== "string") {
      return false;
    }
    if (normalizeCategories(typedArgs.categories) === "") {
      return false;
    }
  }

  if (typedArgs.response_format !== undefined) {
    if (typeof typedArgs.response_format !== "string") {
      return false;
    }
    if (typedArgs.response_format !== "classic" && typedArgs.response_format !== "full") {
      return false;
    }
  }

  return true;
}

export const WEB_SEARCH_TOOL: Tool = {
  name: "searxng_web_search",
  description:
    "Performs a web search using the SearXNG API, ideal for general queries, news, articles, and online content. " +
    "Supports category-specific search (news, images, videos, music, files, it, science, social media). " +
    "Use this for broad information gathering, recent events, or when you need diverse web sources.",
  annotations: {
    readOnlyHint: true,
    openWorldHint: true,
  },
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The search query. This is the main input for the web search",
      },
      pageno: {
        type: "number",
        description: "Search page number (starts at 1)",
        default: 1,
      },
      time_range: {
        type: "string",
        description: "Time range of search (day, month, year)",
        enum: ["day", "month", "year"],
      },
      language: {
        type: "string",
        description:
          "Language code for search results (e.g., 'en', 'fr', 'de'). Default is instance-dependent.",
        default: "all",
      },
      safesearch: {
        type: "number",
        description: "Safe search filter level (0: None, 1: Moderate, 2: Strict)",
        enum: [0, 1, 2],
        default: 0,
      },
      categories: {
        type: "string",
        description:
          "Search categories (comma-separated). Options: general, news, images, videos, music, files, it, science, social media. Default: general.",
      },
      response_format: {
        type: "string",
        description:
          "Response format: 'classic' returns Title/Description/URL/Score (default, backward-compatible). 'full' returns all available fields with key-value passthrough.",
        enum: ["classic", "full"],
        default: "classic",
      },
    },
    required: ["query"],
  },
};

export const READ_URL_TOOL: Tool = {
  name: "web_url_read",
  description:
    "Read the content from an URL. " +
    "Use this for further information retrieving to understand the content of each URL.",
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
