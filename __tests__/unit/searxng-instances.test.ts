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
  getSearxngBasicAuthHeader,
  isSearxngFanoutEnabled,
  parseSearxngUrls,
  redactSearxngInstanceUrl,
  recordSearxngInstanceFailure,
  recordSearxngInstanceSuccess,
  stripSearxngInstanceUrlUserinfo,
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

  await testFunction('redactSearxngInstanceUrl strips userinfo from unparsable URL strings', () => {
    const redacted = redactSearxngInstanceUrl('https://user:pass@ho st.example.com');

    assert.equal(redacted, 'https://ho st.example.com');
    assert.ok(!redacted.includes('user'), redacted);
    assert.ok(!redacted.includes('pass'), redacted);
  }, results);

  await testFunction('redactSearxngInstanceUrl strips multi-at userinfo from unparsable URL strings', () => {
    const redacted = redactSearxngInstanceUrl('https://a:b@c@ho st.example.com');

    assert.equal(redacted, 'https://ho st.example.com');
    assert.ok(redacted.includes('ho st.example.com'), redacted);
    assert.ok(!redacted.includes('a:b'), redacted);
    assert.ok(!redacted.includes('@c'), redacted);
  }, results);

  await testFunction('redactSearxngInstanceUrl leaves non-URL strings unchanged after parse failure', () => {
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

  await testFunction('stripSearxngInstanceUrlUserinfo removes credentials and preserves request target', () => {
    const stripped = stripSearxngInstanceUrlUserinfo(new URL('https://user:pass@search.example.com/base/search?q=test#top'));

    assert.equal(stripped.toString(), 'https://search.example.com/base/search?q=test#top');
    assert.equal(stripped.username, '');
    assert.equal(stripped.password, '');
  }, results);

  await testFunction('getSearxngBasicAuthHeader decodes percent-encoded URL credentials', () => {
    const header = getSearxngBasicAuthHeader(new URL('https://user:p%40ss@search.example.com'));

    assert.equal(header, `Basic ${Buffer.from('user:p@ss').toString('base64')}`);
  }, results);

  await testFunction('getSearxngBasicAuthHeader supports username-only URL credentials', () => {
    const header = getSearxngBasicAuthHeader(new URL('https://token@search.example.com'));

    assert.equal(header, `Basic ${Buffer.from('token:').toString('base64')}`);
  }, results);

  await testFunction('getSearxngBasicAuthHeader tolerates malformed percent-encoding in userinfo', () => {
    // A literal `%` the operator forgot to encode parses as a URL but makes
    // decodeURIComponent throw — the header must fall back to the raw value, not crash.
    const header = getSearxngBasicAuthHeader(new URL('https://user:100%@search.example.com'));

    assert.equal(header, `Basic ${Buffer.from('user:100%').toString('base64')}`);
  }, results);

  await testFunction('getSearxngBasicAuthHeader ignores password-only URL userinfo (no username)', () => {
    envManager.delete('AUTH_USERNAME');
    envManager.delete('AUTH_PASSWORD');

    // Password-only userinfo is treated as absent — no stray secret is sent.
    const header = getSearxngBasicAuthHeader(new URL('https://:pass@search.example.com'));

    assert.equal(header, undefined);

    envManager.restore();
  }, results);

  await testFunction('getSearxngBasicAuthHeader falls back to global auth only without URL userinfo', () => {
    envManager.set('AUTH_USERNAME', 'global-user');
    envManager.set('AUTH_PASSWORD', 'global-pass');

    const header = getSearxngBasicAuthHeader(new URL('https://search.example.com'));

    assert.equal(header, `Basic ${Buffer.from('global-user:global-pass').toString('base64')}`);

    envManager.restore();
  }, results);

  await testFunction('getSearxngBasicAuthHeader returns undefined when no credentials exist', () => {
    envManager.delete('AUTH_USERNAME');
    envManager.delete('AUTH_PASSWORD');

    const header = getSearxngBasicAuthHeader(new URL('https://search.example.com'));

    assert.equal(header, undefined);

    envManager.restore();
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
