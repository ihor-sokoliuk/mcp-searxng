/**
 * Public instance discovery from the searx.space health feed.
 *
 * When discovery is enabled, the server ranks healthy public SearXNG instances
 * from https://searx.space/data/instances.json and hands the ordered list to the
 * existing replica failover (`SEARXNG_URL` semantics). The ranked list is cached
 * on disk for a day, so a cold start pays one request and later starts read the
 * cache. A stale cache is still used when the feed is unreachable.
 *
 * Ranking prefers instances that actually return results over instances that are
 * merely fast: search success rate, then working engine count, then the Mozilla
 * Observatory score, then latency, then version. Instances that report analytics
 * collection, non-normal network types, failed searches, or a slow median are
 * excluded instead of down-ranked, because a fast instance that returns nothing
 * is worse than no candidate at all.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { writeDiagnostic } from "./diagnostic-output.js";
import { parseBoundedInteger } from "./env-int.js";
import { applyTrustedServiceRequestConfig, fetchSearxng } from "./proxy.js";
import { parseSearxngUrls, setDiscoveredSearxngInstances } from "./searxng-instances.js";

export const DEFAULT_DISCOVERY_FEED = "https://searx.space/data/instances.json";
const DEFAULT_DISCOVERY_TTL_SECONDS = 86_400;
const DEFAULT_POOL_SIZE = 10;
const DEFAULT_MIN_SEARCH_PERCENT = 90;
const DEFAULT_MAX_MEDIAN_SECONDS = 5;
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_POOL_SIZE = 50;
const REFRESH_INTERVAL_MS = 3_600_000;
const DISCOVERY_SENTINELS: Record<string, true> = {
  "searx.space": true,
  "https://searx.space": true,
  "https://searx.space/": true,
};

/** Returns the parsed feed payload; injected in tests to avoid network access. */
export type DiscoveryFetcher = (url: string, timeoutMs: number) => Promise<unknown>;

export interface DiscoveryOptions {
  feed: string;
  ttlMs: number;
  pool: number;
  minSearchPercent: number;
  maxMedianSeconds: number;
  timeoutMs: number;
  cacheFile: string;
  /** Instances from SEARXNG_URL; they always stay ahead of discovered ones. */
  configured: string[];
  fetchImpl?: DiscoveryFetcher;
}

export interface DiscoverySelection {
  total: number;
  eligible: number;
  instances: string[];
}

export interface DiscoveryResult extends DiscoverySelection {
  origin: "cache" | "refreshed" | "stale-cache";
  cacheAgeMs: number;
}

interface DiscoveryCache {
  fetchedAt: string;
  feed: string;
  instances: string[];
  total: number;
  eligible: number;
}

interface RankedInstance {
  url: string;
  searchPercent: number;
  engines: number;
  httpScore: number;
  medianSeconds: number;
  version: string;
}

let refreshTimer: NodeJS.Timeout | undefined;

function readObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * Discovery is enabled by `SEARXNG_DISCOVERY=searx.space`, or by pointing
 * `SEARXNG_URL` at the searx.space sentinel instead of a real instance.
 */
export function isInstanceDiscoveryRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  const mode = (env.SEARXNG_DISCOVERY ?? "").trim().toLowerCase();
  if (DISCOVERY_SENTINELS[mode]) {
    return true;
  }
  if (mode !== "") {
    return false;
  }
  return DISCOVERY_SENTINELS[(env.SEARXNG_URL ?? "").trim().toLowerCase()] === true;
}

/**
 * Validates the configured feed URL. The operator owns this setting, so the
 * check is about rejecting unusable input (non-HTTP schemes, embedded
 * credentials) rather than about trusting the caller.
 */
export function resolveDiscoveryFeed(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return null;
  }
  if (url.username !== "" || url.password !== "") {
    return null;
  }
  return url.toString();
}

/** Cache file location, following XDG on Linux and Library/Caches on macOS. */
export function discoveryCacheFile(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.SEARXNG_DISCOVERY_CACHE?.trim();
  if (explicit) {
    return explicit;
  }
  const xdgCache = env.XDG_CACHE_HOME?.trim();
  const root = xdgCache
    ? xdgCache
    : process.platform === "darwin"
      ? join(homedir(), "Library", "Caches")
      : join(homedir(), ".cache");
  return join(root || tmpdir(), "mcp-searxng", "instances.json");
}

/** Reads numeric settings, returning one value-free warning per invalid setting. */
export function resolveDiscoveryOptions(env: NodeJS.ProcessEnv = process.env): {
  options: DiscoveryOptions;
  warnings: string[];
} {
  const warnings: string[] = [];
  const read = (name: string, fallback: number, minimum: number, maximum: number): number => {
    const parsed = parseBoundedInteger(env[name], fallback, minimum, maximum);
    if (parsed.invalid) {
      warnings.push(`${name} is outside ${minimum}-${maximum}; using ${fallback}`);
    }
    return parsed.value;
  };

  const ttlSeconds = read(
    "SEARXNG_DISCOVERY_TTL_SECONDS",
    DEFAULT_DISCOVERY_TTL_SECONDS,
    60,
    2_592_000,
  );

  const feedSetting = env.SEARXNG_DISCOVERY_FEED?.trim();
  const validatedFeed = feedSetting ? resolveDiscoveryFeed(feedSetting) : DEFAULT_DISCOVERY_FEED;
  if (feedSetting && !validatedFeed) {
    warnings.push("SEARXNG_DISCOVERY_FEED must be an http(s) URL without credentials; using the default feed");
  }

  return {
    options: {
      feed: validatedFeed ?? DEFAULT_DISCOVERY_FEED,
      ttlMs: ttlSeconds * 1000,
      pool: read("SEARXNG_DISCOVERY_POOL", DEFAULT_POOL_SIZE, 1, MAX_POOL_SIZE),
      minSearchPercent: read(
        "SEARXNG_DISCOVERY_MIN_SEARCH_PERCENT",
        DEFAULT_MIN_SEARCH_PERCENT,
        0,
        100,
      ),
      maxMedianSeconds: read(
        "SEARXNG_DISCOVERY_MAX_MEDIAN_SECONDS",
        DEFAULT_MAX_MEDIAN_SECONDS,
        1,
        3_600,
      ),
      timeoutMs: read("SEARXNG_DISCOVERY_TIMEOUT_MS", DEFAULT_TIMEOUT_MS, 1_000, 120_000),
      cacheFile: discoveryCacheFile(env),
      configured: parseSearxngUrls(env.SEARXNG_URL ?? "").filter(
        (instance) => !DISCOVERY_SENTINELS[instance.toLowerCase()],
      ),
    },
    warnings,
  };
}

type HttpHealth = { score: number };
type SearchHealth = { percent: number; engines: number; medianSeconds: number };

function readHttpHealth(entry: Record<string, unknown>): HttpHealth | null {
  const http = readObject(entry.http);
  if (readNumber(http?.status_code) !== 200 || readString(http?.error)) {
    return null;
  }
  return { score: readNumber(http?.score) ?? 0 };
}

function readSearchHealth(entry: Record<string, unknown>): SearchHealth | null {
  const search = readObject(readObject(entry.timing)?.search);
  if (!search || readString(search.error)) {
    return null;
  }
  const percent = readNumber(search.success_percentage);
  const engines = readNumber(search.working_engines);
  const medianSeconds = readNumber(readObject(search.all)?.median);
  if (percent === undefined || engines === undefined || medianSeconds === undefined) {
    return null;
  }
  return { percent, engines, medianSeconds };
}

function isRankableEntry(entry: Record<string, unknown>, url: string): boolean {
  const usableSource = entry.network_type === "normal" && entry.analytics !== true;
  return usableSource && url.startsWith("https://");
}

function searchMatchesOptions(
  search: SearchHealth,
  options: Pick<DiscoveryOptions, "minSearchPercent" | "maxMedianSeconds">,
): boolean {
  const coverage = search.engines > 0 && search.percent >= options.minSearchPercent;
  return coverage && search.medianSeconds <= options.maxMedianSeconds;
}

function rankInstance(
  url: string,
  raw: unknown,
  options: Pick<DiscoveryOptions, "minSearchPercent" | "maxMedianSeconds">,
): RankedInstance | null {
  const entry = readObject(raw);
  if (!entry || !isRankableEntry(entry, url)) {
    return null;
  }

  const http = readHttpHealth(entry);
  if (!http) {
    return null;
  }

  const search = readSearchHealth(entry);
  if (!search || !searchMatchesOptions(search, options)) {
    return null;
  }

  return {
    url: url.replace(/\/+$/, ""),
    searchPercent: search.percent,
    engines: search.engines,
    httpScore: http.score,
    medianSeconds: search.medianSeconds,
    version: readString(entry.version) ?? "",
  };
}

function compareInstances(a: RankedInstance, b: RankedInstance): number {
  if (a.searchPercent !== b.searchPercent) {
    return b.searchPercent - a.searchPercent;
  }
  if (a.engines !== b.engines) {
    return b.engines - a.engines;
  }
  if (a.httpScore !== b.httpScore) {
    return b.httpScore - a.httpScore;
  }
  if (a.medianSeconds !== b.medianSeconds) {
    return a.medianSeconds - b.medianSeconds;
  }
  if (a.version !== b.version) {
    return b.version.localeCompare(a.version);
  }
  return a.url.localeCompare(b.url);
}

/** Ranks the feed entries and returns the best `pool` instance URLs. */
export function selectInstances(
  feed: unknown,
  options: Pick<DiscoveryOptions, "pool" | "minSearchPercent" | "maxMedianSeconds">,
): DiscoverySelection {
  const instances = readObject(readObject(feed)?.instances);
  if (!instances) {
    throw new Error("discovery feed has no instances map");
  }
  const entries = Object.entries(instances);
  if (entries.length === 0) {
    throw new Error("discovery feed returned no instances");
  }

  const ranked: RankedInstance[] = [];
  const seen = new Set<string>();
  for (const [url, raw] of entries) {
    const candidate = rankInstance(url, raw, options);
    if (!candidate || seen.has(candidate.url)) {
      continue;
    }
    seen.add(candidate.url);
    ranked.push(candidate);
  }

  ranked.sort(compareInstances);
  return {
    total: entries.length,
    eligible: ranked.length,
    instances: ranked.slice(0, options.pool).map((instance) => instance.url),
  };
}

function readCachedInstances(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((instance): instance is string => typeof instance === "string" && instance !== "")
    : [];
}

export function readDiscoveryCache(file: string): DiscoveryCache | null {
  try {
    // Cache path is operator-configured or the platform cache directory.
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- deliberate cache location, not a trust boundary
    const cache = readObject(JSON.parse(readFileSync(file, "utf8")));
    if (!cache) {
      return null;
    }
    const instances = readCachedInstances(cache.instances);
    if (instances.length === 0 || typeof cache.fetchedAt !== "string") {
      return null;
    }
    return {
      fetchedAt: cache.fetchedAt,
      feed: typeof cache.feed === "string" ? cache.feed : "",
      instances,
      total: readNumber(cache.total) ?? instances.length,
      eligible: readNumber(cache.eligible) ?? instances.length,
    };
  } catch {
    return null;
  }
}

export function writeDiscoveryCache(file: string, cache: DiscoveryCache): void {
  // Same deliberate cache location as readDiscoveryCache; the write is atomic
  // so a crash mid-write cannot leave a truncated cache behind.
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- deliberate cache location, not a trust boundary
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- deliberate cache location, not a trust boundary
  writeFileSync(temporary, `${JSON.stringify(cache, null, 2)}\n`, { mode: 0o644 });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- deliberate cache location, not a trust boundary
  renameSync(temporary, file);
}

export function cacheAgeMs(cache: DiscoveryCache, now = Date.now()): number {
  const fetchedAt = Date.parse(cache.fetchedAt);
  return Number.isFinite(fetchedAt) ? now - fetchedAt : Number.POSITIVE_INFINITY;
}

export async function fetchDiscoveryFeed(url: string, timeoutMs: number): Promise<unknown> {
  const requestOptions: RequestInit = {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  };
  // Operator-configured service URL: reuse the shared trusted-service client so
  // global proxy and CA settings apply, exactly as SEARXNG_URL requests do.
  applyTrustedServiceRequestConfig(requestOptions, url);
  const response = await fetchSearxng(url, requestOptions);
  if (!response.ok) {
    throw new Error(`discovery feed responded ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as unknown;
}

/**
 * Returns the instance list, reading the cache when it is still fresh and
 * falling back to a stale cache when the feed cannot be reached.
 */
// The cache keeps the full ranking (capped at MAX_POOL_SIZE) so changing
// SEARXNG_DISCOVERY_POOL takes effect at the next start instead of after the
// cache expires.
function resultFromCache(
  cached: DiscoveryCache,
  origin: DiscoveryResult["origin"],
  cacheAgeMs: number,
  pool: number,
): DiscoveryResult {
  return {
    total: cached.total,
    eligible: cached.eligible,
    instances: cached.instances.slice(0, pool),
    origin,
    cacheAgeMs,
  };
}

async function fetchAndCache(options: DiscoveryOptions): Promise<DiscoveryResult> {
  const fetchImpl = options.fetchImpl ?? fetchDiscoveryFeed;
  const feed = await fetchImpl(options.feed, options.timeoutMs);
  const selection = selectInstances(feed, { ...options, pool: MAX_POOL_SIZE });
  if (selection.instances.length === 0) {
    throw new Error("no instance passed the health filter");
  }
  writeDiscoveryCache(options.cacheFile, {
    fetchedAt: new Date().toISOString(),
    feed: options.feed,
    instances: selection.instances,
    total: selection.total,
    eligible: selection.eligible,
  });
  return {
    ...selection,
    instances: selection.instances.slice(0, options.pool),
    origin: "refreshed",
    cacheAgeMs: 0,
  };
}

/**
 * Returns the instance list, reading the cache when it is still fresh and
 * falling back to a stale cache when the feed cannot be reached.
 */
export async function resolveDiscoveredInstances(
  options: DiscoveryOptions,
): Promise<DiscoveryResult> {
  const cached = readDiscoveryCache(options.cacheFile);
  const cachedAge = cached ? cacheAgeMs(cached) : Number.POSITIVE_INFINITY;

  if (cached && cachedAge < options.ttlMs && cached.feed === options.feed) {
    return resultFromCache(cached, "cache", cachedAge, options.pool);
  }

  try {
    return await fetchAndCache(options);
  } catch (error) {
    if (cached && cached.instances.length > 0) {
      return resultFromCache(cached, "stale-cache", cachedAge, options.pool);
    }
    throw error;
  }
}

/** Configured instances first, then discovered replicas, without duplicates. */
export function mergeWithConfigured(configured: string[], discovered: string[]): string[] {
  return [...new Set([...configured, ...discovered])];
}

/**
 * Re-resolves the list when the cache expired, then installs it. Returns true
 * when the active instance list was replaced.
 */
export async function refreshDiscoveredInstancesIfExpired(
  options: DiscoveryOptions,
): Promise<boolean> {
  const cached = readDiscoveryCache(options.cacheFile);
  if (cached && cacheAgeMs(cached) < options.ttlMs) {
    return false;
  }
  try {
    const result = await resolveDiscoveredInstances(options);
    setDiscoveredSearxngInstances(mergeWithConfigured(options.configured, result.instances));
    return true;
  } catch (error) {
    writeDiagnostic(
      "warn",
      `Instance discovery refresh failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

/** Refreshes the instance list in the background once the cache expires. */
export function startDiscoveryRefresh(options: DiscoveryOptions): NodeJS.Timeout {
  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    void refreshDiscoveredInstancesIfExpired(options);
  }, REFRESH_INTERVAL_MS);
  refreshTimer.unref();
  return refreshTimer;
}

/**
 * Runs discovery when requested and installs the result as the active instance
 * list. Returns true when the server can search without `SEARXNG_URL`.
 */
export async function initializeInstanceDiscovery(
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  if (!isInstanceDiscoveryRequested(env)) {
    return false;
  }

  const { options, warnings } = resolveDiscoveryOptions(env);
  for (const warning of warnings) {
    writeDiagnostic("warn", warning);
  }

  try {
    const result = await resolveDiscoveredInstances(options);
    if (result.instances.length === 0) {
      throw new Error("discovery produced an empty instance list");
    }
    setDiscoveredSearxngInstances(mergeWithConfigured(options.configured, result.instances));
    if (result.origin === "stale-cache") {
      writeDiagnostic(
        "warn",
        `Instance discovery reused a stale cache (${Math.round(result.cacheAgeMs / 3_600_000)} h old)`,
      );
    }
    startDiscoveryRefresh(options);
    return true;
  } catch (error) {
    writeDiagnostic(
      "warn",
      `Instance discovery is enabled but produced no usable instance: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
}

/** Clears timer and instance override so unit tests start from a clean module. */
export function resetInstanceDiscoveryForTests(): void {
  clearInterval(refreshTimer);
  refreshTimer = undefined;
  setDiscoveredSearxngInstances(null);
}
