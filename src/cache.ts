interface CacheEntry {
  htmlContent: string;
  markdownContent: string;
  timestamp: number;
}

class SimpleCache {
  private cache = new Map<string, CacheEntry>();
  private readonly ttlMs: number;
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(ttlMs: number = 60000) { // Default 1 minute TTL
    this.ttlMs = ttlMs;
    this.startCleanup();
  }

  private startCleanup(): void {
    // Clean up expired entries every 30 seconds
    this.cleanupInterval = setInterval(() => {
      this.cleanupExpired();
    }, 30000);
  }

  private cleanupExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > this.ttlMs) {
        this.cache.delete(key);
      }
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

    return entry;
  }

  set(url: string, htmlContent: string, markdownContent: string): void {
    this.cache.set(url, {
      htmlContent,
      markdownContent,
      timestamp: Date.now()
    });
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
  getStats(): { size: number; entries: Array<{ url: string; age: number }> } {
    const now = Date.now();
    const entries = Array.from(this.cache.entries()).map(([url, entry]) => ({
      url,
      age: now - entry.timestamp
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