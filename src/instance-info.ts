import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { logMessage } from "./logging.js";
import { createDefaultAgent, createProxyAgent, ProxyType } from "./proxy.js";
import { getPrimarySearxngInstance } from "./searxng-instances.js";

type SearXNGConfig = Record<string, any>;
type ConfigResult =
  | { available: true; config: SearXNGConfig; sourceUrl: string }
  | { available: false; message: string; status?: number; sourceUrl?: string };

let cachedConfig: SearXNGConfig | null = null;
let cachedBaseUrl: string | null = null;

function unavailable(message: string, status?: number, sourceUrl?: string): string {
  return JSON.stringify({
    available: false,
    ...(sourceUrl !== undefined ? { sourceUrl } : {}),
    message,
    ...(status !== undefined ? { status } : {}),
  }, null, 2);
}

function categoryNamesFromEngines(config: SearXNGConfig): string[] {
  const names = new Set<string>();

  if (Array.isArray(config.engines)) {
    for (const engine of config.engines) {
      for (const category of engineCategories(engine)) {
        if (typeof category === "string" && category.trim() !== "") {
          names.add(category);
        }
      }
    }
  }

  return [...names];
}

function namesFromCategories(config: SearXNGConfig): string[] {
  const names = new Set<string>();

  if (Array.isArray(config.categories)) {
    for (const category of config.categories) {
      if (typeof category === "string" && category.trim() !== "") {
        names.add(category);
      }
    }
  } else if (config.categories && typeof config.categories === "object") {
    for (const category of Object.keys(config.categories)) {
      if (category.trim() !== "") {
        names.add(category);
      }
    }
  }

  for (const category of categoryNamesFromEngines(config)) {
    names.add(category);
  }

  return [...names].sort();
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
  sourceUrl: string,
  includeEngines: boolean,
  includeDisabled: boolean,
  category?: string,
): string {
  const categories = category
    ? namesFromCategories(config).filter((name) => name === category)
    : namesFromCategories(config);

  const payload: Record<string, unknown> = {
    available: true,
    sourceUrl,
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

async function fetchConfig(mcpServer: McpServer, refresh = false): Promise<ConfigResult> {
  const base = getPrimarySearxngInstance();
  if (!base) {
    return {
      available: false,
      message: "SEARXNG_URL is not configured; cannot fetch SearXNG /config.",
    };
  }

  if (refresh) {
    cachedConfig = null;
  }

  if (cachedConfig && cachedBaseUrl === base) {
    return { available: true, config: cachedConfig, sourceUrl: base };
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
        sourceUrl: base,
      };
    }

    cachedConfig = await response.json() as SearXNGConfig;
    cachedBaseUrl = base;
    return { available: true, config: cachedConfig, sourceUrl: base };
  } catch (error) {
    logMessage(mcpServer, "warning", `SearXNG /config fetch failed: ${error instanceof Error ? error.message : String(error)}`);
    return {
      available: false,
      message: "SearXNG /config is unavailable; instance capability discovery could not complete.",
      sourceUrl: base,
    };
  }
}

export async function getKnownEngines(mcpServer: McpServer, refresh = false): Promise<Set<string> | null> {
  const result = await fetchConfig(mcpServer, refresh);
  if (!result.available) {
    return null;
  }

  return allEngineNames(result.config);
}

export async function getKnownCategories(mcpServer: McpServer, refresh = false): Promise<Set<string> | null> {
  const result = await fetchConfig(mcpServer, refresh);
  if (!result.available) {
    return null;
  }

  return new Set(namesFromCategories(result.config));
}

export async function fetchInstanceInfo(
  mcpServer: McpServer,
  includeEngines = false,
  includeDisabled = false,
  category?: string,
  refresh = false,
): Promise<string> {
  const result = await fetchConfig(mcpServer, refresh);
  if (!result.available) {
    return unavailable(result.message, result.status, result.sourceUrl);
  }

  return formatInstanceInfo(result.config, result.sourceUrl, includeEngines, includeDisabled, category);
}
