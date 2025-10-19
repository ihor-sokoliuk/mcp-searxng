#!/usr/bin/env tsx

/**
 * Unit Tests: types.ts
 * 
 * Tests for type guards and type definitions
 */

import { strict as assert } from 'node:assert';
import { isSearXNGWebSearchArgs } from '../../src/types.js';
import { isWebUrlReadArgs } from '../../src/index.js';
import { testFunction, createTestResults, printTestSummary } from '../helpers/test-utils.js';

const results = createTestResults();

async function runTests() {
  console.log('🧪 Testing: types.ts\n');

  await testFunction('isSearXNGWebSearchArgs type guard - valid cases', () => {
    assert.equal(isSearXNGWebSearchArgs({ query: 'test', language: 'en' }), true);
    assert.equal(isSearXNGWebSearchArgs({ query: 'test search' }), true);
    assert.equal(isSearXNGWebSearchArgs({ query: 'test', pageno: 1, time_range: 'day' }), true);
  }, results);

  await testFunction('isSearXNGWebSearchArgs type guard - invalid cases', () => {
    assert.equal(isSearXNGWebSearchArgs({ notQuery: 'test' }), false);
    assert.equal(isSearXNGWebSearchArgs(null), false);
    assert.equal(isSearXNGWebSearchArgs(undefined), false);
    assert.equal(isSearXNGWebSearchArgs('string'), false);
    assert.equal(isSearXNGWebSearchArgs(123), false);
    assert.equal(isSearXNGWebSearchArgs({}), false);
  }, results);

  await testFunction('isWebUrlReadArgs type guard - basic valid cases', () => {
    assert.equal(isWebUrlReadArgs({ url: 'https://example.com' }), true);
    assert.equal(isWebUrlReadArgs({ url: 'http://test.com' }), true);
  }, results);

  await testFunction('isWebUrlReadArgs type guard - with pagination parameters', () => {
    assert.equal(isWebUrlReadArgs({ url: 'https://example.com', startChar: 0 }), true);
    assert.equal(isWebUrlReadArgs({ url: 'https://example.com', maxLength: 100 }), true);
    assert.equal(isWebUrlReadArgs({ url: 'https://example.com', section: 'intro' }), true);
    assert.equal(isWebUrlReadArgs({ url: 'https://example.com', paragraphRange: '1-5' }), true);
    assert.equal(isWebUrlReadArgs({ url: 'https://example.com', readHeadings: true }), true);
  }, results);

  await testFunction('isWebUrlReadArgs type guard - with all parameters', () => {
    assert.equal(isWebUrlReadArgs({
      url: 'https://example.com',
      startChar: 10,
      maxLength: 200,
      section: 'section1',
      paragraphRange: '2-4',
      readHeadings: false
    }), true);
  }, results);

  await testFunction('isWebUrlReadArgs type guard - invalid cases', () => {
    assert.equal(isWebUrlReadArgs({ notUrl: 'invalid' }), false);
    assert.equal(isWebUrlReadArgs(null), false);
    assert.equal(isWebUrlReadArgs(undefined), false);
    assert.equal(isWebUrlReadArgs('string'), false);
    assert.equal(isWebUrlReadArgs(123), false);
    assert.equal(isWebUrlReadArgs({}), false);
  }, results);

  await testFunction('isWebUrlReadArgs type guard - invalid parameter types', () => {
    assert.equal(isWebUrlReadArgs({ url: 'https://example.com', startChar: -1 }), false);
    assert.equal(isWebUrlReadArgs({ url: 'https://example.com', maxLength: 0 }), false);
    assert.equal(isWebUrlReadArgs({ url: 'https://example.com', startChar: 'invalid' }), false);
    assert.equal(isWebUrlReadArgs({ url: 'https://example.com', maxLength: 'invalid' }), false);
    assert.equal(isWebUrlReadArgs({ url: 'https://example.com', section: 123 }), false);
    assert.equal(isWebUrlReadArgs({ url: 'https://example.com', paragraphRange: 123 }), false);
    assert.equal(isWebUrlReadArgs({ url: 'https://example.com', readHeadings: 'invalid' }), false);
  }, results);

  printTestSummary(results, 'Types Module');
  return results;
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runTests().then(results => {
    process.exit(results.failed > 0 ? 1 : 0);
  }).catch(console.error);
}

export { runTests };
