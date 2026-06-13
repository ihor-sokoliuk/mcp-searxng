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

  await testFunction('Cache TTL expiration', async () => {
    const testCache = new SimpleCache(50); // 50ms TTL

    testCache.set('short-lived', '<html>test</html>', '# Test');

    // Should exist immediately
    assert.ok(testCache.get('short-lived'));

    // Wait for expiration
    await new Promise(resolve => setTimeout(resolve, 100));

    // Should be expired
    assert.equal(testCache.get('short-lived'), null);

    testCache.destroy();
  }, results);

  await testFunction('Cache uses CACHE_TTL_MS when constructed without explicit TTL', async () => {
    const previousTtl = process.env.CACHE_TTL_MS;
    process.env.CACHE_TTL_MS = '1000';
    const testCache = new SimpleCache();

    try {
      testCache.set('env-ttl', '<html>test</html>', '# Test');

      assert.ok(testCache.get('env-ttl'));

      await new Promise(resolve => setTimeout(resolve, 1050));

      assert.equal(testCache.get('env-ttl'), null);
    } finally {
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

  await testFunction('Cache get() returns null after TTL expiry', async () => {
    const testCache = new SimpleCache(50); // 50ms TTL

    testCache.set('cleanup-test', '<html>test</html>', '# Test');

    // Wait for cleanup to run
    await new Promise(resolve => setTimeout(resolve, 150));

    // Entry should be cleaned up
    assert.equal(testCache.get('cleanup-test'), null);

    testCache.destroy();
  }, results);

  await testFunction('Cache cleanup interval removes expired entries', async () => {
    // Use 50ms TTL and 1ms cleanup interval so the interval fires quickly
    const testCache = new SimpleCache(50, 500, 1);

    testCache.set('cleanup-target', '<html>test</html>', '# Test');

    // Confirm entry exists immediately
    assert.ok(testCache.get('cleanup-target'));

    // Wait for TTL to expire (50ms) + a few cleanup ticks (5ms buffer)
    await new Promise(resolve => setTimeout(resolve, 80));

    // Cleanup interval has fired and should have removed the expired entry
    assert.equal(testCache.get('cleanup-target'), null);

    testCache.destroy();
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
