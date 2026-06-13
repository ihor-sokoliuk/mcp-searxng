import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { logMessage } from "./logging.js";
import { createDefaultAgent, createProxyAgent, ProxyType } from "./proxy.js";

type SearXNGConfig = Record<string, any>;
type ConfigResult =
  | { available: true; config: SearXNGConfig }
  | { available: false; message: string; status?: number };

let cachedConfig: SearXNGConfig | null = null;
let cachedBaseUrl: string | null = null;

function unavailable(message: string, status?: number): string {
  return JSON.stringify({
    available: false,
    message,
    ...(status !== undefined ? { status } : {}),
  }, null, 2);
}

function namesFromCategories(config: SearXNGConfig): string[] {
  if (!config.categories || typeof config.categories !== "object") {
    return [];
  }
  return Object.keys(config.categories).sort();
}

function engineCategories(engine: any): string[] {
  if (Array.isArray(engine.categories)) {
    return engine.categories;
  }
  if (typeof engine.category === "string") {
    return [engine.category];
  }
  return [];
}

function collectEngines(config: SearXNGConfig, includeDisabled: boolean, category?: string) {
  const enabled = new Set<string>();
  const disabled = new Set<string>();

  if (Array.isArray(config.engines)) {
    for (const engine of config.engines) {
      if (!engine || typeof engine.name !== "string") {
        continue;
      }
      const categories = engineCategories(engine);
      if (category && !categories.includes(category)) {
        continue;
      }
      if (engine.disabled) {
        if (includeDisabled) {
          disabled.add(engine.name);
        }
      } else {
        enabled.add(engine.name);
      }
    }
  }

  return {
    enabled: [...enabled].sort(),
    ...(includeDisabled ? { disabled: [...disabled].sort() } : {}),
  };
}

function allEngineNames(config: SearXNGConfig): Set<string> {
  const names = new Set<string>();

  if (Array.isArray(config.engines)) {
    for (const engine of config.engines) {
      if (engine && typeof engine.name === "string") {
        names.add(engine.name);
      }
    }
  }

  return names;
}

function formatInstanceInfo(
  config: SearXNGConfig,
  includeEngines: boolean,
  includeDisabled: boolean,
  category?: string,
): string {
  const categories = category
    ? namesFromCategories(config).filter((name) => name === category)
    : namesFromCategories(config);

  const payload: Record<string, unknown> = {
    available: true,
    categories,
    defaults: {
      safesearch: config.search?.safe_search ?? config.default_safe_search,
      locale: config.default_locale,
      language: config.default_language,
      theme: config.default_theme,
    },
    locales: config.locales,
    plugins: config.plugins ?? [],
  };

  if (includeEngines) {
    payload.engines = collectEngines(config, includeDisabled, category);
  }

  return JSON.stringify(payload, null, 2);
}

export function clearInstanceInfoCacheForTests(): void {
  cachedConfig = null;
  cachedBaseUrl = null;
}

async function fetchConfig(mcpServer: McpServer): Promise<ConfigResult> {
  const base = process.env.SEARXNG_URL;
  if (!base) {
    return {
      available: false,
      message: "SEARXNG_URL is not configured; cannot fetch SearXNG /config.",
    };
  }

  if (cachedConfig && cachedBaseUrl === base) {
    return { available: true, config: cachedConfig };
  }

  const parsedBase = new URL(base.endsWith("/") ? base : `${base}/`);
  const url = new URL("config", parsedBase);

  try {
    const requestOptions: RequestInit = {
      signal: AbortSignal.timeout(5000),
    };
    const proxyAgent = createProxyAgent(url.toString(), ProxyType.SEARCH);
    const dispatcher = proxyAgent ?? createDefaultAgent();
    if (dispatcher) {
      (requestOptions as any).dispatcher = dispatcher;
    }

    const response = await fetch(url.toString(), requestOptions);
    if (!response.ok) {
      return {
        available: false,
        message: `SearXNG /config is unavailable: HTTP ${response.status} ${response.statusText}`,
        status: response.status,
      };
    }

    cachedConfig = await response.json() as SearXNGConfig;
    cachedBaseUrl = base;
    return { available: true, config: cachedConfig };
  } catch (error) {
    logMessage(mcpServer, "warning", `SearXNG /config fetch failed: ${error instanceof Error ? error.message : String(error)}`);
    return {
      available: false,
      message: "SearXNG /config is unavailable; instance capability discovery could not complete.",
    };
  }
}

export async function getKnownEngines(mcpServer: McpServer): Promise<Set<string> | null> {
  const result = await fetchConfig(mcpServer);
  if (!result.available) {
    return null;
  }

  return allEngineNames(result.config);
}

export async function fetchInstanceInfo(
  mcpServer: McpServer,
  includeEngines = false,
  includeDisabled = false,
  category?: string,
  refresh = false,
): Promise<string> {
  if (refresh) {
    cachedConfig = null;
  }

  const result = await fetchConfig(mcpServer);
  if (!result.available) {
    return unavailable(result.message, result.status);
  }

  return formatInstanceInfo(result.config, includeEngines, includeDisabled, category);
}
