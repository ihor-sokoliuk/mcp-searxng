#!/usr/bin/env tsx

/**
 * Unit Tests: cache.ts
 * 
 * Tests for caching functionality
 */

import { strict as assert } from 'node:assert';
import { fileURLToPath } from 'node:url';
import { SimpleCache, urlCache } from '../../src/cache.js';
import { testFunction, createTestResults, printTestSummary } from '../helpers/test-utils.js';

const results = createTestResults();

async function runTests() {
  console.log('🧪 Testing: cache.ts\n');

  await testFunction('Basic cache operations - set and get', () => {
    const testCache = new SimpleCache(1000); // 1 second TTL

    // Test set and get
    testCache.set('test-url', '<html>test</html>', '# Test');
    const entry = testCache.get('test-url');
    assert.ok(entry);
    assert.equal(entry.htmlContent, '<html>test</html>');
    assert.equal(entry.markdownContent, '# Test');

    testCache.destroy();
  }, results);

  await testFunction('Cache hitCount increments on repeated get() hits', () => {
    const testCache = new SimpleCache(1000);

    testCache.set('popular-url', '<html>popular</html>', '# Popular');

    assert.equal(testCache.get('popular-url')?.hitCount, 1);
    assert.equal(testCache.get('popular-url')?.hitCount, 2);
    assert.equal(testCache.get('popular-url')?.hitCount, 3);

    testCache.destroy();
  }, results);

  await testFunction('Cache returns null for non-existent keys', () => {
    const testCache = new SimpleCache(1000);
    
    assert.equal(testCache.get('non-existent'), null);

    testCache.destroy();
  }, results);

  await testFunction('Cache TTL expiration', () => {
    // Drive expiry with a controlled clock instead of sleeping real time:
    // get() decides expiry via Date.now() (src/cache.ts), and setTimeout vs
    // Date.now() are not guaranteed to advance in lockstep (notably on WSL2),
    // which made the wall-clock version flaky. This is deterministic and instant.
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    try {
      const testCache = new SimpleCache(50); // 50ms TTL

      testCache.set('short-lived', '<html>test</html>', '# Test');

      // Should exist immediately
      assert.ok(testCache.get('short-lived'));

      // Advance past the TTL
      now += 51;

      // Should be expired
      assert.equal(testCache.get('short-lived'), null);

      testCache.destroy();
    } finally {
      Date.now = realNow;
    }
  }, results);

  await testFunction('Cache uses CACHE_TTL_MS when constructed without explicit TTL', () => {
    const previousTtl = process.env.CACHE_TTL_MS;
    process.env.CACHE_TTL_MS = '1000';
    // Controlled clock (see 'Cache TTL expiration') — deterministic, no real sleep.
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    const testCache = new SimpleCache();

    try {
      testCache.set('env-ttl', '<html>test</html>', '# Test');

      assert.ok(testCache.get('env-ttl'));

      // Advance past the env-configured 1000ms TTL
      now += 1001;

      assert.equal(testCache.get('env-ttl'), null);
    } finally {
      Date.now = realNow;
      testCache.destroy();
      if (previousTtl === undefined) {
        delete process.env.CACHE_TTL_MS;
      } else {
        process.env.CACHE_TTL_MS = previousTtl;
      }
    }
  }, results);

  await testFunction('Cache falls back to defaults for invalid CACHE_TTL_MS and CACHE_MAX_ENTRIES', () => {
    const previousTtl = process.env.CACHE_TTL_MS;
    const previousMaxEntries = process.env.CACHE_MAX_ENTRIES;
    process.env.CACHE_TTL_MS = 'not-a-number';
    process.env.CACHE_MAX_ENTRIES = '0';

    const testCache = new SimpleCache();

    try {
      assert.equal((testCache as any).ttlMs, 86400000);
      assert.equal((testCache as any).maxEntries, 500);
    } finally {
      testCache.destroy();
      if (previousTtl === undefined) {
        delete process.env.CACHE_TTL_MS;
      } else {
        process.env.CACHE_TTL_MS = previousTtl;
      }
      if (previousMaxEntries === undefined) {
        delete process.env.CACHE_MAX_ENTRIES;
      } else {
        process.env.CACHE_MAX_ENTRIES = previousMaxEntries;
      }
    }
  }, results);

  await testFunction('Cache clear functionality', () => {
    const testCache = new SimpleCache(1000);

    testCache.set('url1', '<html>1</html>', '# 1');
    testCache.set('url2', '<html>2</html>', '# 2');

    assert.ok(testCache.get('url1'));
    assert.ok(testCache.get('url2'));

    testCache.clear();

    assert.equal(testCache.get('url1'), null);
    assert.equal(testCache.get('url2'), null);

    testCache.destroy();
  }, results);

  await testFunction('Cache statistics', () => {
    const testCache = new SimpleCache(1000);

    testCache.set('url1', '<html>1</html>', '# 1');
    testCache.set('url2', '<html>2</html>', '# 2');

    const stats = testCache.getStats();
    assert.equal(stats.size, 2);
    assert.equal(stats.entries.length, 2);

    // Check that entries have age information
    assert.ok(stats.entries[0].age >= 0);
    assert.ok(stats.entries[0].url);

    testCache.destroy();
  }, results);

  await testFunction('Cache evicts lowest hitCount entry when capacity is exceeded', () => {
    const testCache = new SimpleCache(1000, 2);

    testCache.set('popular-url', '<html>popular</html>', '# Popular');
    testCache.set('cold-url', '<html>cold</html>', '# Cold');

    for (let i = 0; i < 5; i++) {
      assert.ok(testCache.get('popular-url'));
    }

    testCache.set('new-url', '<html>new</html>', '# New');

    assert.ok(testCache.get('popular-url'), 'Expected popular URL to remain cached');
    assert.equal(testCache.get('cold-url'), null, 'Expected cold URL to be evicted');
    assert.ok(testCache.get('new-url'), 'Expected new URL to remain cached');
    assert.equal(testCache.getStats().size, 2);

    testCache.destroy();
  }, results);

  await testFunction('Cache purges expired entries before LFU eviction', () => {
    // Controlled clock (see 'Cache TTL expiration') — deterministic, no real sleep.
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    try {
      const testCache = new SimpleCache(50, 2, 1000);

      testCache.set('expired-popular-url', '<html>expired</html>', '# Expired');
      for (let i = 0; i < 5; i++) {
        assert.ok(testCache.get('expired-popular-url'));
      }

      // Advance past the 50ms TTL so the popular entry is now expired
      now += 51;

      testCache.set('fresh-url', '<html>fresh</html>', '# Fresh');
      testCache.set('new-url', '<html>new</html>', '# New');

      assert.equal(testCache.get('expired-popular-url'), null, 'Expected expired popular URL to be purged');
      assert.ok(testCache.get('fresh-url'), 'Expected fresh URL to remain cached');
      assert.ok(testCache.get('new-url'), 'Expected new URL to remain cached');
      assert.equal(testCache.getStats().size, 2);

      testCache.destroy();
    } finally {
      Date.now = realNow;
    }
  }, results);

  await testFunction('Cache normalizes invalid cleanup interval to default', () => {
    const testCache = new SimpleCache(1000, 500, Number.NaN);
    const interval = (testCache as any).cleanupInterval;

    assert.ok(interval, 'Expected cleanup interval to be created');
    assert.equal((interval as any)._idleTimeout, 60000);
    assert.equal(interval.hasRef(), false, 'Cleanup interval should be unref()ed');

    testCache.destroy();
  }, results);

  await testFunction('Cache uses CACHE_MAX_ENTRIES to evict when fourth entry is added', () => {
    const previousMaxEntries = process.env.CACHE_MAX_ENTRIES;
    process.env.CACHE_MAX_ENTRIES = '3';
    const testCache = new SimpleCache();

    try {
      testCache.set('url1', '<html>1</html>', '# 1');
      testCache.set('url2', '<html>2</html>', '# 2');
      testCache.set('url3', '<html>3</html>', '# 3');
      testCache.set('url4', '<html>4</html>', '# 4');

      assert.equal(testCache.getStats().size, 3);
      assert.equal(testCache.get('url1'), null);
      assert.ok(testCache.get('url2'));
      assert.ok(testCache.get('url3'));
      assert.ok(testCache.get('url4'));
    } finally {
      testCache.destroy();
      if (previousMaxEntries === undefined) {
        delete process.env.CACHE_MAX_ENTRIES;
      } else {
        process.env.CACHE_MAX_ENTRIES = previousMaxEntries;
      }
    }
  }, results);

  await testFunction('Global cache instance', () => {
    // Test that global cache exists and works
    urlCache.clear(); // Start fresh

    urlCache.set('global-test', '<html>global</html>', '# Global');
    const entry = urlCache.get('global-test');

    assert.ok(entry);
    assert.equal(entry.markdownContent, '# Global');

    urlCache.clear();
  }, results);

  await testFunction('Cache get() returns null after TTL expiry', () => {
    // Controlled clock (see 'Cache TTL expiration') — deterministic, no real sleep.
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    try {
      const testCache = new SimpleCache(50); // 50ms TTL

      testCache.set('cleanup-test', '<html>test</html>', '# Test');

      // Advance past the TTL
      now += 51;

      assert.equal(testCache.get('cleanup-test'), null);

      testCache.destroy();
    } finally {
      Date.now = realNow;
    }
  }, results);

  await testFunction('Cache cleanup interval removes expired entries', async () => {
    // The expiry decision is deterministic via a controlled clock; only the 1ms
    // interval *firing* needs real time (a scheduler dependency, not the flaky
    // wall-clock-vs-timer one). Assert via getStats() — which does NOT lazily
    // expire — so this verifies the background interval purged the entry rather
    // than get()'s own expiry check.
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    try {
      const testCache = new SimpleCache(50, 500, 1); // 50ms TTL, 1ms cleanup interval

      testCache.set('cleanup-target', '<html>test</html>', '# Test');
      assert.equal(testCache.getStats().size, 1);

      // Logically expire the entry, then let the 1ms interval fire and purge it.
      now += 51;
      for (let i = 0; i < 100 && testCache.getStats().size > 0; i++) {
        await new Promise(resolve => setTimeout(resolve, 5));
      }

      assert.equal(testCache.getStats().size, 0, 'Expected cleanup interval to purge the expired entry');

      testCache.destroy();
    } finally {
      Date.now = realNow;
    }
  }, results);

  await testFunction('Cache cleanup interval does not keep process alive', () => {
    const testCache = new SimpleCache(1000, 500, 1000);
    const interval = (testCache as any).cleanupInterval;

    assert.ok(interval, 'Expected cleanup interval to be created');
    assert.equal(interval.hasRef(), false, 'Cleanup interval should be unref()ed');

    testCache.destroy();
  }, results);

  printTestSummary(results, 'Cache Module');
  return results;
}

// Run if executed directly
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  runTests().then(results => {
    process.exit(results.failed > 0 ? 1 : 0);
  }).catch(console.error);
}

export { runTests };
