import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createDefaultAgent, createProxyAgent, ProxyType } from "./proxy.js";
import { logMessage } from "./logging.js";
import {
  MCPSearXNGError,
  createJSONError,
  createNetworkError,
  createServerError,
  type ErrorContext,
  validateEnvironment,
} from "./error-handler.js";
import {
  SearXNGInstanceConfig,
  SearXNGInstanceEngine,
  SearXNGInstancePlugin,
} from "./types.js";

export interface InstanceInfoOptions {
  includeEngines?: boolean;
  includeDisabled?: boolean;
  category?: string;
}

function normalizeCategory(category?: string): string | undefined {
  const trimmed = category?.trim();
  return trimmed ? trimmed.toLowerCase() : undefined;
}

function normalizeConfig(data: unknown): SearXNGInstanceConfig {
  if (typeof data !== "object" || data === null) {
    throw new MCPSearXNGError(
      "🔍 SearXNG Config Error: Invalid /config response shape"
    );
  }

  const typedData = data as Record<string, unknown>;

  const categories = Array.isArray(typedData.categories)
    ? typedData.categories.filter(
        (category): category is string => typeof category === "string"
      )
    : [];

  const engines = Array.isArray(typedData.engines)
    ? typedData.engines
        .filter(
          (engine): engine is Record<string, unknown> =>
            typeof engine === "object" && engine !== null
        )
        .map(
          (engine): SearXNGInstanceEngine => ({
            categories: Array.isArray(engine.categories)
              ? engine.categories.filter(
                  (category): category is string => typeof category === "string"
                )
              : [],
            enabled:
              typeof engine.enabled === "boolean" ? engine.enabled : undefined,
            name: typeof engine.name === "string" ? engine.name : undefined,
            shortcut:
              typeof engine.shortcut === "string"
                ? engine.shortcut
                : undefined,
          })
        )
    : [];

  const plugins = Array.isArray(typedData.plugins)
    ? typedData.plugins
        .filter(
          (plugin): plugin is Record<string, unknown> =>
            typeof plugin === "object" && plugin !== null
        )
        .map(
          (plugin): SearXNGInstancePlugin => ({
            enabled:
              typeof plugin.enabled === "boolean"
                ? plugin.enabled
                : undefined,
            name: typeof plugin.name === "string" ? plugin.name : undefined,
          })
        )
    : [];

  const locales =
    typeof typedData.locales === "object" && typedData.locales !== null
      ? Object.entries(typedData.locales).reduce<Record<string, string>>(
          (result, [key, value]) => {
            if (typeof value === "string") {
              result[key] = value;
            }
            return result;
          },
          {}
        )
      : {};

  return {
    autocomplete:
      typeof typedData.autocomplete === "string"
        ? typedData.autocomplete
        : undefined,
    categories,
    default_locale:
      typeof typedData.default_locale === "string"
        ? typedData.default_locale
        : undefined,
    default_theme:
      typeof typedData.default_theme === "string"
        ? typedData.default_theme
        : undefined,
    engines,
    instance_name:
      typeof typedData.instance_name === "string"
        ? typedData.instance_name
        : undefined,
    locales,
    plugins,
    safe_search:
      typeof typedData.safe_search === "number"
        ? typedData.safe_search
        : undefined,
  };
}

function buildEngineLines(engines: SearXNGInstanceEngine[]): string[] {
  return engines
    .filter((engine) => typeof engine.name === "string" && engine.name.length > 0)
    .map((engine) => {
      const parts = [engine.name!];

      if (engine.shortcut) {
        parts.push(`shortcut: ${engine.shortcut}`);
      }

      if (engine.categories && engine.categories.length > 0) {
        parts.push(`categories: ${engine.categories.join(", ")}`);
      }

      parts.push(`enabled: ${engine.enabled === false ? "no" : "yes"}`);
      return `- ${parts.join(" | ")}`;
    });
}

function filterEngines(
  engines: SearXNGInstanceEngine[],
  options: InstanceInfoOptions
): SearXNGInstanceEngine[] {
  const normalizedCategory = normalizeCategory(options.category);

  return engines.filter((engine) => {
    if (!options.includeDisabled && engine.enabled === false) {
      return false;
    }

    if (!normalizedCategory) {
      return true;
    }

    return (
      engine.categories?.some(
        (category) => category.toLowerCase() === normalizedCategory
      ) ?? false
    );
  });
}

function formatPlugins(plugins: SearXNGInstancePlugin[]): string {
  if (plugins.length === 0) {
    return "none";
  }

  const pluginDescriptions = plugins
    .filter((plugin) => typeof plugin.name === "string" && plugin.name.length > 0)
    .map(
      (plugin) =>
        `${plugin.name} (${plugin.enabled === false ? "disabled" : "enabled"})`
    );

  return pluginDescriptions.length > 0
    ? pluginDescriptions.join(", ")
    : "none";
}

export function formatInstanceInfo(
  config: SearXNGInstanceConfig,
  options: InstanceInfoOptions = {}
): string {
  const engines = config.engines ?? [];
  const enabledEngines = engines.filter((engine) => engine.enabled !== false);
  const shouldIncludeEngines = options.includeEngines || !!options.category;
  const matchingEngines = shouldIncludeEngines
    ? filterEngines(engines, options)
    : [];
  const lines = [
    `Instance Name: ${config.instance_name || "unknown"}`,
    `Default Locale: ${config.default_locale || "instance default"}`,
    `Default Theme: ${config.default_theme || "instance default"}`,
    `Safe Search Default: ${
      config.safe_search !== undefined ? config.safe_search : "instance default"
    }`,
    `Autocomplete Provider: ${config.autocomplete || "disabled"}`,
    `Categories (${config.categories?.length || 0}): ${
      config.categories && config.categories.length > 0
        ? config.categories.join(", ")
        : "none"
    }`,
    `Locales Available: ${Object.keys(config.locales || {}).length}`,
    `Engines: ${enabledEngines.length} enabled / ${engines.length} total`,
    `Plugins: ${formatPlugins(config.plugins || [])}`,
  ];

  if (shouldIncludeEngines) {
    lines.push("");
    lines.push(
      `Matching Engines (${matchingEngines.length})${
        options.category ? ` for category "${options.category}"` : ""
      }:`
    );

    const engineLines = buildEngineLines(matchingEngines);
    if (engineLines.length === 0) {
      lines.push("- none");
    } else {
      lines.push(...engineLines);
    }
  }

  return lines.join("\n");
}

export async function fetchInstanceConfig(
  mcpServer: McpServer
): Promise<SearXNGInstanceConfig> {
  const validationError = validateEnvironment();
  if (validationError) {
    logMessage(mcpServer, "error", "Configuration invalid");
    throw new MCPSearXNGError(validationError);
  }

  const searxngUrl = process.env.SEARXNG_URL!;
  const parsedUrl = new URL(
    searxngUrl.endsWith("/") ? searxngUrl : `${searxngUrl}/`
  );
  const url = new URL("config", parsedUrl);

  const requestOptions: RequestInit = {
    method: "GET",
  };

  const proxyAgent = createProxyAgent(url.toString(), ProxyType.SEARCH);
  const dispatcher = proxyAgent ?? createDefaultAgent();
  if (dispatcher) {
    (requestOptions as any).dispatcher = dispatcher;
  }

  const username = process.env.AUTH_USERNAME;
  const password = process.env.AUTH_PASSWORD;
  if (username && password) {
    const base64Auth = Buffer.from(`${username}:${password}`).toString("base64");
    requestOptions.headers = {
      ...requestOptions.headers,
      Authorization: `Basic ${base64Auth}`,
    };
  }

  const userAgent = process.env.USER_AGENT;
  if (userAgent) {
    requestOptions.headers = {
      ...requestOptions.headers,
      "User-Agent": userAgent,
    };
  }

  let response: Response;
  try {
    logMessage(mcpServer, "info", `Fetching SearXNG instance config: ${url}`);
    response = await fetch(url.toString(), requestOptions);
  } catch (error: any) {
    logMessage(
      mcpServer,
      "error",
      `Network error during /config request: ${error.message}`,
      { url: url.toString() }
    );
    const context: ErrorContext = {
      url: url.toString(),
      searxngUrl,
      proxyAgent: !!dispatcher,
      username,
    };
    throw createNetworkError(error, context);
  }

  if (!response.ok) {
    let responseBody: string;
    try {
      responseBody = await response.text();
    } catch {
      responseBody = "[Could not read response body]";
    }

    const context: ErrorContext = {
      url: url.toString(),
      searxngUrl,
    };
    throw createServerError(
      response.status,
      response.statusText,
      responseBody,
      context
    );
  }

  let data: unknown;
  try {
    data = (await response.json()) as unknown;
  } catch {
    let responseText: string;
    try {
      responseText = await response.text();
    } catch {
      responseText = "[Could not read response text]";
    }

    const context: ErrorContext = { url: url.toString() };
    throw createJSONError(responseText, context);
  }

  return normalizeConfig(data);
}

export async function getInstanceInfo(
  mcpServer: McpServer,
  options: InstanceInfoOptions = {}
): Promise<string> {
  const config = await fetchInstanceConfig(mcpServer);
  return formatInstanceInfo(config, options);
}
