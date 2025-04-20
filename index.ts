#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { NodeHtmlMarkdown } from "node-html-markdown";

// Use a static version string that will be updated by the version script
const packageVersion = "0.4.5";

const WEB_SEARCH_TOOL: Tool = {
  name: "searxng_web_search",
  description:
    "Performs a web search using the SearXNG API, ideal for general queries, news, articles, and online content. " +
    "Use this for broad information gathering, recent events, or when you need diverse web sources.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "The search query. This is the main input for the web search",
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
        default: "month",
      },
      language: {
        type: "string",
        description:
          "Language code for search results (e.g., 'en', 'fr', 'de'). Default is instance-dependent.",
        default: "all",
      },
      safesearch: {
        type: "string",
        description:
          "Safe search filter level (0: None, 1: Moderate, 2: Strict)",
        enum: ["0", "1", "2"],
        default: "0",
      },
    },
    required: ["query"],
  },
};

const READ_URL_TOOL: Tool = {
  name: "web_url_read",
  description:
    "Read the content from an URL. " +
    "Use this for further information retrieving to understand the content of each URL.",
  inputSchema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "URL",
      },
    },
    required: ["url"],
  },
};

// Server implementation
const server = new Server(
  {
    name: "ihor-sokoliuk/mcp-searxng",
    version: packageVersion,
  },
  {
    capabilities: {
      resources: {},
      tools: {
        searxng_web_search: {
          description: WEB_SEARCH_TOOL.description,
          schema: WEB_SEARCH_TOOL.inputSchema,
        },
        web_url_read: {
          description: READ_URL_TOOL.description,
          schema: READ_URL_TOOL.inputSchema,
        },
      },
    },
  }
);

interface SearXNGWeb {
  results: Array<{
    title: string;
    content: string;
    url: string;
  }>;
}

function isSearXNGWebSearchArgs(args: unknown): args is {
  query: string;
  pageno?: number;
  time_range: string;
  language?: string;
  safesearch: string;
} {
  return (
    typeof args === "object" &&
    args !== null &&
    "query" in args &&
    typeof (args as { query: string }).query === "string"
  );
}

async function performWebSearch(
  query: string,
  pageno: number = 1,
  time_range: string = "month",
  language: string = "all",
  safesearch: string = "0"
) {
  const searxngUrl = process.env.SEARXNG_URL || "http://localhost:8080";
  const url = new URL(`${searxngUrl}/search`);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("pageno", pageno.toString());

  if (time_range && ["day", "month", "year"].includes(time_range)) {
    url.searchParams.set("time_range", time_range);
  }

  if (language && language !== "all") {
    url.searchParams.set("language", language);
  }

  url.searchParams.set("safesearch", safesearch);

  const response = await fetch(url.toString(), {
    method: "GET",
  });

  if (!response.ok) {
    throw new Error(
      `SearXNG API error: ${response.status} ${
        response.statusText
      }\n${await response.text()}`
    );
  }

  const data = (await response.json()) as SearXNGWeb;

  const results = (data.results || []).map((result) => ({
    title: result.title || "",
    content: result.content || "",
    url: result.url || "",
  }));

  return results
    .map((r) => `Title: ${r.title}\nDescription: ${r.content}\nURL: ${r.url}`)
    .join("\n\n");
}

async function fetchAndConvertToMarkdown(
  url: string,
  timeoutMs: number = 10000
) {
  // Create an AbortController instance
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // Fetch the URL with the abort signal
    const response = await fetch(url, {
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch the URL: ${response.statusText}`);
    }

    // Retrieve HTML content
    const htmlContent = await response.text();

    // Convert HTML to Markdown
    const markdownContent = NodeHtmlMarkdown.translate(htmlContent);

    return markdownContent;
  } catch (error: any) {
    if (error.name === "AbortError") {
      throw new Error(`Request timed out after ${timeoutMs}ms`);
    }
    console.error("Error:", error.message);
    throw error;
  } finally {
    // Clean up the timeout to prevent memory leaks
    clearTimeout(timeoutId);
  }
}
// Tool handlers
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [WEB_SEARCH_TOOL, READ_URL_TOOL],
}));

server.setRequestHandler(CallToolRequestSchema, async (request: any) => {
  try {
    const { name, arguments: args } = request.params;

    if (!args) {
      throw new Error("No arguments provided");
    }

    if (name === "searxng_web_search") {
      if (!isSearXNGWebSearchArgs(args)) {
        throw new Error("Invalid arguments for searxng_web_search");
      }
      const {
        query,
        pageno = 1,
        time_range = "month",
        language = "all",
        safesearch,
      } = args;
      const results = await performWebSearch(
        query,
        pageno,
        time_range,
        language,
        safesearch
      );
      return {
        content: [{ type: "text", text: results }],
        isError: false,
      };
    }

    if (name === "web_url_read") {
      const { url } = args;
      const result = await fetchAndConvertToMarkdown(url as string);
      return {
        content: [{ type: "text", text: result }],
        isError: false,
      };
    }

    return {
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
      isError: true,
    };
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Error: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
      ],
      isError: true,
    };
  }
});

async function runServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

runServer().catch((error) => {
  console.error("Fatal error running server:", error);
  process.exit(1);
});
