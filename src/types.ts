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

export function isSearXNGWebSearchArgs(args: unknown): args is {
  query: string;
  pageno?: number;
  time_range?: string;
  language?: string;
  safesearch?: number;
} {
  return (
    typeof args === "object" &&
    args !== null &&
    "query" in args &&
    typeof (args as { query: string }).query === "string"
  );
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

export const WEB_SEARCH_TOOL: Tool = {
  name: "searxng_web_search",
  description:
    "Searches the web using SearXNG. " +
    "CRITICAL: The parameter name MUST be exactly `query` (not `prompt`, `q`, or any other name). " +
    "Pass your search terms as the value of the `query` parameter.",
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
        description:
          "Safe search filter level (0: None, 1: Moderate, 2: Strict)",
        enum: [0, 1, 2],
        default: 0,
      },
    },
    required: ["query"],
  },
};

export const INSTANCE_INFO_TOOL: Tool = {
  name: "searxng_instance_info",
  description:
    "Retrieves live configuration details from the configured SearXNG instance using its /config endpoint. " +
    "Use this before category-specific or engine-specific searches when you need to discover what the instance actually supports.",
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
          "Include matching engine details in the response. Defaults to false.",
        default: false,
      },
      includeDisabled: {
        type: "boolean",
        description:
          "Include disabled engines when returning engine details. Defaults to false.",
        default: false,
      },
      category: {
        type: "string",
        description:
          "Optional category filter for the engine list. Supplying this also implies engine details should be included.",
      },
    },
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
