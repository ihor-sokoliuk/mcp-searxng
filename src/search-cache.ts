import { createHash } from "crypto";
import { parsePositiveInteger, normalizePositiveInteger } from "./env-int.js";

interface SearchCacheEntry {
  result: string;
  timestamp: number;
  hitCount: number;
}

const DEFAULT_SEARCH_CACHE_TTL_MS = 86400000;
const DEFAULT_SEARCH_CACHE_MAX_ENTRIES = 200;

function stableCanonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableCanonicalize);
  }

  if (value !== null && typeof value === "object") {
    const canonical: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      canonical[key] = stableCanonicalize((value as Record<string, unknown>)[key]);
    }
    return canonical;
  }

  return value;
}

export class SearchCache {
  private cache = new Map<string, SearchCacheEntry>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(
    ttlMs: number = parsePositiveInteger(process.env.SEARCH_CACHE_TTL_MS, DEFAULT_SEARCH_CACHE_TTL_MS),
    maxEntries: number = parsePositiveInteger(process.env.SEARCH_CACHE_MAX_ENTRIES, DEFAULT_SEARCH_CACHE_MAX_ENTRIES),
  ) {
    this.ttlMs = normalizePositiveInteger(ttlMs, DEFAULT_SEARCH_CACHE_TTL_MS);
    this.maxEntries = normalizePositiveInteger(maxEntries, DEFAULT_SEARCH_CACHE_MAX_ENTRIES);
  }

  private key(toolName: string, args: Record<string, unknown>): string {
    const canonical = JSON.stringify([toolName, stableCanonicalize(args)]);
    return createHash("sha256").update(canonical).digest("hex");
  }

  get(toolName: string, args: Record<string, unknown>): string | null {
    const key = this.key(toolName, args);
    const entry = this.cache.get(key);
    if (!entry) {
      return null;
    }

    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(key);
      return null;
    }

    entry.hitCount++;
    return entry.result;
  }

  set(toolName: string, args: Record<string, unknown>, result: string): void {
    this.cache.set(this.key(toolName, args), {
      result,
      timestamp: Date.now(),
      hitCount: 0,
    });
    this.evictIfNeeded();
  }

  private cleanupExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > this.ttlMs) {
        this.cache.delete(key);
      }
    }
  }

  private evictIfNeeded(): void {
    this.cleanupExpired();

    while (this.cache.size > this.maxEntries) {
      let evictionKey: string | null = null;
      let evictionEntry: SearchCacheEntry | null = null;

      for (const [key, entry] of this.cache.entries()) {
        if (
          evictionEntry === null ||
          entry.hitCount < evictionEntry.hitCount ||
          (entry.hitCount === evictionEntry.hitCount && entry.timestamp < evictionEntry.timestamp)
        ) {
          evictionKey = key;
          evictionEntry = entry;
        }
      }

      if (evictionKey === null) {
        return;
      }

      this.cache.delete(evictionKey);
    }
  }

  clear(): void {
    this.cache.clear();
  }

  getStats(): { size: number; entries: Array<{ key: string; age: number; hitCount: number }> } {
    const now = Date.now();
    const entries = Array.from(this.cache.entries()).map(([key, entry]) => ({
      key,
      age: now - entry.timestamp,
      hitCount: entry.hitCount,
    }));

    return {
      size: this.cache.size,
      entries,
    };
  }
}

export const searchCache = new SearchCache();
