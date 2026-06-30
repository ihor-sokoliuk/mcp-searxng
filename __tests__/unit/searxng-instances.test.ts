#!/usr/bin/env tsx

/**
 * Unit Tests: searxng-instances.ts
 *
 * Tests for SearXNG instance list parsing, validation, fanout, and cooldown state.
 */

import { strict as assert } from 'node:assert';
import { fileURLToPath } from 'node:url';
import {
  clearSearxngInstanceStateForTests,
  getHealthySearxngInstances,
  getPrimarySearxngInstance,
  getSearxngInstances,
  isSearxngFanoutEnabled,
  parseSearxngUrls,
  redactSearxngInstanceUrl,
  recordSearxngInstanceFailure,
  recordSearxngInstanceSuccess,
  validateSearxngInstanceUrl,
} from '../../src/searxng-instances.js';
import { testFunction, createTestResults, printTestSummary } from '../helpers/test-utils.js';
import { EnvManager } from '../helpers/env-utils.js';

const results = createTestResults();
const envManager = new EnvManager();

async function runTests() {
  console.log('🧪 Testing: searxng-instances.ts\n');

  await testFunction('parseSearxngUrls preserves a single URL unchanged', () => {
    assert.deepEqual(parseSearxngUrls('https://search.example.com'), ['https://search.example.com']);
  }, results);

  await testFunction('parseSearxngUrls splits semicolon list, trims, and drops empty segments', () => {
    assert.deepEqual(
      parseSearxngUrls(' https://a.example.com ; ; https://b.example.com/ ;  '),
      ['https://a.example.com', 'https://b.example.com/'],
    );
  }, results);

  await testFunction('parseSearxngUrls returns empty list for empty-only values', () => {
    assert.deepEqual(parseSearxngUrls(''), []);
    assert.deepEqual(parseSearxngUrls(';'), []);
    assert.deepEqual(parseSearxngUrls(' ; '), []);
  }, results);

  await testFunction('getSearxngInstances and getPrimarySearxngInstance read current environment', () => {
    envManager.set('SEARXNG_URL', 'https://first.example.com;https://second.example.com');

    assert.deepEqual(getSearxngInstances(), ['https://first.example.com', 'https://second.example.com']);
    assert.equal(getPrimarySearxngInstance(), 'https://first.example.com');

    envManager.restore();
  }, results);

  await testFunction('validateSearxngInstanceUrl accepts http and https URLs', () => {
    assert.equal(validateSearxngInstanceUrl('http://localhost:8080'), null);
    assert.equal(validateSearxngInstanceUrl('https://search.example.com'), null);
  }, results);

  await testFunction('validateSearxngInstanceUrl rejects invalid and non-http URLs', () => {
    assert.ok(validateSearxngInstanceUrl('not-a-url')?.includes('not-a-url'));
    assert.ok(validateSearxngInstanceUrl('ftp://search.example.com')?.includes('ftp:'));
  }, results);

  await testFunction('redactSearxngInstanceUrl removes username and password userinfo', () => {
    assert.equal(
      redactSearxngInstanceUrl('https://user:pass@search.example.com/path?q=1'),
      'https://search.example.com/path?q=1',
    );
  }, results);

  await testFunction('redactSearxngInstanceUrl removes username-only userinfo', () => {
    assert.equal(
      redactSearxngInstanceUrl('https://user@search.example.com/path'),
      'https://search.example.com/path',
    );
  }, results);

  await testFunction('redactSearxngInstanceUrl removes password-only userinfo', () => {
    assert.equal(
      redactSearxngInstanceUrl('https://:pass@search.example.com/path'),
      'https://search.example.com/path',
    );
  }, results);

  await testFunction('redactSearxngInstanceUrl leaves invalid strings unchanged', () => {
    assert.equal(redactSearxngInstanceUrl('not a url'), 'not a url');
  }, results);

  await testFunction('redactSearxngInstanceUrl leaves credential-free URLs byte-identical', () => {
    const urls = [
      'https://search.example.com',
      'https://SEARCH.example.com/%7Euser?q=a%20b',
      'http://localhost:8080/searxng/?q=test#top',
    ];

    for (const url of urls) {
      assert.equal(redactSearxngInstanceUrl(url), url);
    }
  }, results);

  await testFunction('isSearxngFanoutEnabled is true only for literal true', () => {
    envManager.set('SEARXNG_FANOUT', 'true');
    assert.equal(isSearxngFanoutEnabled(), true);

    envManager.set('SEARXNG_FANOUT', 'TRUE');
    assert.equal(isSearxngFanoutEnabled(), false);

    envManager.delete('SEARXNG_FANOUT');
    assert.equal(isSearxngFanoutEnabled(), false);

    envManager.restore();
  }, results);

  await testFunction('third consecutive hard failure cools instance for 60 seconds', () => {
    clearSearxngInstanceStateForTests();
    const instances = ['https://a.example.com', 'https://b.example.com'];
    const now = 1000;

    recordSearxngInstanceFailure('https://a.example.com', now);
    recordSearxngInstanceFailure('https://a.example.com', now + 1);
    assert.deepEqual(getHealthySearxngInstances(instances, now + 2), instances);

    recordSearxngInstanceFailure('https://a.example.com', now + 3);
    assert.deepEqual(getHealthySearxngInstances(instances, now + 4), ['https://b.example.com']);
    assert.deepEqual(getHealthySearxngInstances(instances, now + 60002), ['https://b.example.com']);
    assert.deepEqual(getHealthySearxngInstances(instances, now + 60003), instances);
  }, results);

  await testFunction('expired cooldown resets failure counter before re-cooling', () => {
    clearSearxngInstanceStateForTests();
    const instances = ['https://a.example.com'];
    const now = 1000;

    recordSearxngInstanceFailure('https://a.example.com', now);
    recordSearxngInstanceFailure('https://a.example.com', now + 1);
    recordSearxngInstanceFailure('https://a.example.com', now + 2);
    assert.deepEqual(getHealthySearxngInstances(instances, now + 3), []);

    assert.deepEqual(getHealthySearxngInstances(instances, now + 60001), []);
    assert.deepEqual(getHealthySearxngInstances(instances, now + 60002), instances);

    recordSearxngInstanceFailure('https://a.example.com', now + 60004);
    recordSearxngInstanceFailure('https://a.example.com', now + 60005);
    assert.deepEqual(getHealthySearxngInstances(instances, now + 60006), instances);

    recordSearxngInstanceFailure('https://a.example.com', now + 60007);
    assert.deepEqual(getHealthySearxngInstances(instances, now + 60008), []);
  }, results);

  await testFunction('observing cooldown expiry clears stale health entry', () => {
    clearSearxngInstanceStateForTests();
    const instances = ['https://a.example.com'];
    const now = 1000;

    recordSearxngInstanceFailure('https://a.example.com', now);
    recordSearxngInstanceFailure('https://a.example.com', now + 1);
    recordSearxngInstanceFailure('https://a.example.com', now + 2);

    assert.deepEqual(getHealthySearxngInstances(instances, now + 60003), instances);
    recordSearxngInstanceFailure('https://a.example.com', now + 60004);
    assert.deepEqual(getHealthySearxngInstances(instances, now + 60005), instances);
  }, results);

  await testFunction('successful response resets consecutive failures before cooldown', () => {
    clearSearxngInstanceStateForTests();
    const instances = ['https://a.example.com'];

    recordSearxngInstanceFailure('https://a.example.com', 1000);
    recordSearxngInstanceFailure('https://a.example.com', 1001);
    recordSearxngInstanceSuccess('https://a.example.com');
    recordSearxngInstanceFailure('https://a.example.com', 1002);

    assert.deepEqual(getHealthySearxngInstances(instances, 1003), instances);
  }, results);

  printTestSummary(results, 'SearXNG Instances Module');
  return results;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  runTests().then(results => {
    process.exit(results.failed > 0 ? 1 : 0);
  }).catch(console.error);
}

export { runTests };
