#!/usr/bin/env tsx

/**
 * Unit Tests: cache.ts
 * 
 * Tests for caching functionality
 */

import { strict as assert } from 'node:assert';
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

  await testFunction('Global cache instance', () => {
    // Test that global cache exists and works
    urlCache.clear(); // Start fresh

    urlCache.set('global-test', '<html>global</html>', '# Global');
    const entry = urlCache.get('global-test');

    assert.ok(entry);
    assert.equal(entry.markdownContent, '# Global');

    urlCache.clear();
  }, results);

  await testFunction('Cache cleanup interval', async () => {
    const testCache = new SimpleCache(50); // 50ms TTL

    testCache.set('cleanup-test', '<html>test</html>', '# Test');

    // Wait for cleanup to run
    await new Promise(resolve => setTimeout(resolve, 150));

    // Entry should be cleaned up
    assert.equal(testCache.get('cleanup-test'), null);

    testCache.destroy();
  }, results);

  printTestSummary(results, 'Cache Module');
  return results;
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runTests().then(results => {
    process.exit(results.failed > 0 ? 1 : 0);
  }).catch(console.error);
}

export { runTests };
