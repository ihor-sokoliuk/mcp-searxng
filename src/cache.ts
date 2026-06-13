interface CacheEntry {
  htmlContent: string;
  markdownContent: string;
  timestamp: number;
  hitCount: number;
}

const DEFAULT_CACHE_TTL_MS = 86400000;
const DEFAULT_CACHE_MAX_ENTRIES = 500;
const DEFAULT_CLEANUP_INTERVAL_MS = 60000;

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) || parsed <= 0 ? fallback : parsed;
}

function normalizePositiveInteger(value: number, fallback: number): number {
  return Number.isNaN(value) || value <= 0 ? fallback : value;
}

class SimpleCache {
  private cache = new Map<string, CacheEntry>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(
    ttlMs: number = parsePositiveInteger(process.env.CACHE_TTL_MS, DEFAULT_CACHE_TTL_MS),
    maxEntries: number = parsePositiveInteger(process.env.CACHE_MAX_ENTRIES, DEFAULT_CACHE_MAX_ENTRIES),
    cleanupIntervalMs: number = DEFAULT_CLEANUP_INTERVAL_MS
  ) {
    this.ttlMs = normalizePositiveInteger(ttlMs, DEFAULT_CACHE_TTL_MS);
    this.maxEntries = normalizePositiveInteger(maxEntries, DEFAULT_CACHE_MAX_ENTRIES);
    this.startCleanup(cleanupIntervalMs);
  }

  private startCleanup(cleanupIntervalMs: number): void {
    // Clean up expired entries every cleanupIntervalMs milliseconds (default 60s)
    this.cleanupInterval = setInterval(() => {
      this.cleanupExpired();
    }, cleanupIntervalMs);
    this.cleanupInterval.unref();
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
    while (this.cache.size > this.maxEntries) {
      let evictionKey: string | null = null;
      let evictionEntry: CacheEntry | null = null;

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

  get(url: string): CacheEntry | null {
    const entry = this.cache.get(url);
    if (!entry) {
      return null;
    }

    // Check if expired
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(url);
      return null;
    }

    entry.hitCount++;
    return entry;
  }

  set(url: string, htmlContent: string, markdownContent: string): void {
    this.cache.set(url, {
      htmlContent,
      markdownContent,
      timestamp: Date.now(),
      hitCount: 0
    });
    this.evictIfNeeded();
  }

  clear(): void {
    this.cache.clear();
  }

  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.clear();
  }

  // Get cache statistics for debugging
  getStats(): { size: number; entries: Array<{ url: string; age: number; hitCount: number }> } {
    const now = Date.now();
    const entries = Array.from(this.cache.entries()).map(([url, entry]) => ({
      url,
      age: now - entry.timestamp,
      hitCount: entry.hitCount
    }));

    return {
      size: this.cache.size,
      entries
    };
  }
}

// Global cache instance
export const urlCache = new SimpleCache();

// Export for testing and cleanup
export { SimpleCache };
