import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { logMessage } from "./logging.js";
import { createDefaultAgent, createProxyAgent, ProxyType } from "./proxy.js";
import { getSearxngInstances } from "./searxng-instances.js";

type SearXNGConfig = Record<string, any>;
type ConfigResult =
  | { available: true; config: SearXNGConfig; sourceUrl: string }
  | { available: false; message: string; status?: number; sourceUrl: string };
type ConfigFailure = { sourceUrl: string; message: string; status?: number };
type ReachableConfig = { config: SearXNGConfig; sourceUrl: string };
type AggregateConfigResult =
  | { available: true; configs: ReachableConfig[]; failures: ConfigFailure[] }
  | { available: false; message: string; failures: ConfigFailure[] };

const cachedConfigs = new Map<string, SearXNGConfig>();

function unavailable(message: string, failures: ConfigFailure[] = []): string {
  return JSON.stringify({
    available: false,
    message,
    ...(failures.length > 0 ? { instancesUnreachable: failures } : {}),
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

function engineSets(config: SearXNGConfig, category?: string) {
  const enabled = new Set<string>();
  const disabled = new Set<string>();
  const all = new Set<string>();

  if (Array.isArray(config.engines)) {
    for (const engine of config.engines) {
      if (!engine || typeof engine.name !== "string") {
        continue;
      }
      const categories = engineCategories(engine);
      if (category && !categories.includes(category)) {
        continue;
      }

      all.add(engine.name);
      if (engine.disabled) {
        disabled.add(engine.name);
      } else {
        enabled.add(engine.name);
      }
    }
  }

  return { enabled, disabled, all };
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

function sorted(values: Set<string>): string[] {
  return [...values].sort();
}

function union(sets: Set<string>[]): Set<string> {
  const result = new Set<string>();
  for (const set of sets) {
    for (const value of set) {
      result.add(value);
    }
  }
  return result;
}

function intersection(sets: Set<string>[]): Set<string> {
  if (sets.length === 0) {
    return new Set();
  }

  const result = new Set(sets[0]);
  for (const set of sets.slice(1)) {
    for (const value of [...result]) {
      if (!set.has(value)) {
        result.delete(value);
      }
    }
  }
  return result;
}

function categoriesForConfig(config: SearXNGConfig, category?: string): Set<string> {
  const names = category
    ? namesFromCategories(config).filter((name) => name === category)
    : namesFromCategories(config);
  return new Set(names);
}

function aggregateCategories(configs: ReachableConfig[], category?: string) {
  const sets = configs.map(({ config }) => categoriesForConfig(config, category));
  return {
    common: sorted(intersection(sets)),
    available: sorted(union(sets)),
  };
}

function aggregateEngines(configs: ReachableConfig[], includeDisabled: boolean, category?: string) {
  const perInstance = configs.map(({ config }) => engineSets(config, category));
  const payload: Record<string, Record<string, string[]>> = {
    common: {
      enabled: sorted(intersection(perInstance.map(({ enabled }) => enabled))),
    },
    available: {
      enabled: sorted(union(perInstance.map(({ enabled }) => enabled))),
    },
  };

  if (includeDisabled) {
    payload.common.disabled = sorted(intersection(perInstance.map(({ disabled }) => disabled)));
    payload.available.disabled = sorted(union(perInstance.map(({ disabled }) => disabled)));
  }

  return payload;
}

function formatInstanceInfo(
  configs: ReachableConfig[],
  failures: ConfigFailure[],
  includeEngines: boolean,
  includeDisabled: boolean,
  category?: string,
): string {
  const primary = configs[0].config;

  const payload: Record<string, unknown> = {
    available: true,
    instancesReachable: configs.map(({ sourceUrl }) => sourceUrl),
    ...(failures.length > 0 ? { instancesUnreachable: failures } : {}),
    categories: aggregateCategories(configs, category),
    defaults: {
      safesearch: primary.search?.safe_search ?? primary.default_safe_search,
      locale: primary.default_locale,
      language: primary.default_language,
      theme: primary.default_theme,
    },
    defaultsNote: "Defaults, locales, and plugins are reported from the primary reachable instance and may vary across configured instances.",
    locales: primary.locales,
    plugins: primary.plugins ?? [],
  };

  if (includeEngines) {
    payload.engines = aggregateEngines(configs, includeDisabled, category);
  }

  return JSON.stringify(payload, null, 2);
}

export function clearInstanceInfoCacheForTests(): void {
  cachedConfigs.clear();
}

async function fetchConfigFromInstance(mcpServer: McpServer, base: string): Promise<ConfigResult> {
  const cached = cachedConfigs.get(base);
  if (cached) {
    return { available: true, config: cached, sourceUrl: base };
  }

  try {
    const parsedBase = new URL(base.endsWith("/") ? base : `${base}/`);
    const url = new URL("config", parsedBase);
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

    const config = await response.json() as SearXNGConfig;
    cachedConfigs.set(base, config);
    return { available: true, config, sourceUrl: base };
  } catch (error) {
    logMessage(mcpServer, "warning", `SearXNG /config fetch failed for ${base}: ${error instanceof Error ? error.message : String(error)}`);
    return {
      available: false,
      message: "SearXNG /config is unavailable; instance capability discovery could not complete.",
      sourceUrl: base,
    };
  }
}

async function fetchConfigs(mcpServer: McpServer, refresh = false): Promise<AggregateConfigResult> {
  const instances = getSearxngInstances();
  if (instances.length === 0) {
    return {
      available: false,
      message: "SEARXNG_URL is not configured; cannot fetch SearXNG /config.",
      failures: [],
    };
  }

  if (refresh) {
    cachedConfigs.clear();
  }

  const results = await Promise.all(instances.map((instance) => fetchConfigFromInstance(mcpServer, instance)));
  const configs = results
    .filter((result): result is { available: true; config: SearXNGConfig; sourceUrl: string } => result.available)
    .map(({ config, sourceUrl }) => ({ config, sourceUrl }));
  const failures = results
    .filter((result): result is { available: false; message: string; status?: number; sourceUrl: string } => !result.available)
    .map(({ sourceUrl, message, status }) => ({
      sourceUrl,
      message,
      ...(status !== undefined ? { status } : {}),
    }));

  if (configs.length === 0) {
    return {
      available: false,
      message: "SearXNG /config is unavailable; no configured instances answered capability discovery.",
      failures,
    };
  }

  return { available: true, configs, failures };
}

export async function getKnownEngines(mcpServer: McpServer, refresh = false): Promise<Set<string> | null> {
  const result = await fetchConfigs(mcpServer, refresh);
  if (!result.available) {
    return null;
  }

  return union(result.configs.map(({ config }) => allEngineNames(config)));
}

export async function getKnownCategories(mcpServer: McpServer, refresh = false): Promise<Set<string> | null> {
  const result = await fetchConfigs(mcpServer, refresh);
  if (!result.available) {
    return null;
  }

  return union(result.configs.map(({ config }) => new Set(namesFromCategories(config))));
}

export async function fetchInstanceInfo(
  mcpServer: McpServer,
  includeEngines = false,
  includeDisabled = false,
  category?: string,
  refresh = false,
): Promise<string> {
  const result = await fetchConfigs(mcpServer, refresh);
  if (!result.available) {
    return unavailable(result.message, result.failures);
  }

  return formatInstanceInfo(result.configs, result.failures, includeEngines, includeDisabled, category);
}
