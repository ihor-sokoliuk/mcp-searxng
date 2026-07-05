#!/usr/bin/env tsx

/**
 * Unit Tests: suggestions.ts
 *
 * Tests for SearXNG autocomplete suggestions.
 */

import { strict as assert } from 'node:assert';
import { fileURLToPath } from 'node:url';
import { performSearchSuggestions } from '../../src/suggestions.js';
import { testFunction, createTestResults, printTestSummary } from '../helpers/test-utils.js';
import { createMockServer } from '../helpers/mock-server.js';
import { FetchMocker, createMockFetch, createCapturingMockFetch } from '../helpers/mock-fetch.js';
import { EnvManager } from '../helpers/env-utils.js';

const results = createTestResults();
const fetchMocker = new FetchMocker();
const envManager = new EnvManager();

async function runTests() {
  console.log('🧪 Testing: suggestions.ts\n');

  await testFunction('returns suggestions array when autocompleter returns valid data', async () => {
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');
    const mockServer = createMockServer();

    fetchMocker.mock(createMockFetch({ json: ['type', ['typescript', 'typescript tutorial']] }));

    const suggestions = await performSearchSuggestions(mockServer as any, 'type');
    assert.deepEqual(suggestions, ['typescript', 'typescript tutorial']);

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('returns empty array when SEARXNG_URL is unset', async () => {
    envManager.delete('SEARXNG_URL');
    const mockServer = createMockServer();
    let fetchCalled = false;

    fetchMocker.mock(async () => {
      fetchCalled = true;
      return createMockFetch({ json: ['type', ['typescript']] })('https://unused.example.com');
    });

    const suggestions = await performSearchSuggestions(mockServer as any, 'type');
    assert.deepEqual(suggestions, []);
    assert.equal(fetchCalled, false);

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('returns empty array when autocompleter returns non-200', async () => {
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');
    const mockServer = createMockServer();

    fetchMocker.mock(createMockFetch({ ok: false, status: 503, statusText: 'Unavailable' }));

    const suggestions = await performSearchSuggestions(mockServer as any, 'type');
    assert.deepEqual(suggestions, []);

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('returns empty array on network error', async () => {
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');
    const mockServer = createMockServer();

    fetchMocker.mock(createMockFetch({ throwError: new Error('network down') }));

    const suggestions = await performSearchSuggestions(mockServer as any, 'type');
    assert.deepEqual(suggestions, []);

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('returns empty array when response shape is malformed', async () => {
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');
    const mockServer = createMockServer();

    fetchMocker.mock(createMockFetch({ json: { suggestions: ['not expected shape'] } }));

    const suggestions = await performSearchSuggestions(mockServer as any, 'type');
    assert.deepEqual(suggestions, []);

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('language parameter is appended when provided', async () => {
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com/subpath');
    const mockServer = createMockServer();
    const { mockFetch, getCapturedUrl } = createCapturingMockFetch();

    fetchMocker.mock(async (url, options) => {
      await mockFetch(url, options);
      return createMockFetch({ json: ['type', ['typescript']] })(url, options);
    });

    await performSearchSuggestions(mockServer as any, 'type', 'fr');

    const url = new URL(getCapturedUrl());
    assert.ok(url.pathname.includes('/subpath/autocompleter'), `Expected /subpath/autocompleter, got ${url.pathname}`);
    assert.equal(url.searchParams.get('q'), 'type');
    assert.equal(url.searchParams.get('lang'), 'fr');

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('multi-URL SEARXNG_URL uses primary instance only for autocomplete', async () => {
    envManager.set('SEARXNG_URL', 'https://primary.example.com/base;https://secondary.example.com');
    const mockServer = createMockServer();
    const { mockFetch, getCapturedUrl } = createCapturingMockFetch();

    fetchMocker.mock(async (url, options) => {
      await mockFetch(url, options);
      return createMockFetch({ json: ['type', ['typescript']] })(url, options);
    });

    await performSearchSuggestions(mockServer as any, 'type');

    const url = new URL(getCapturedUrl());
    assert.equal(url.origin, 'https://primary.example.com');
    assert.ok(url.pathname.includes('/base/autocompleter'), `Expected primary /base/autocompleter, got ${url.pathname}`);

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('autocompleter fetch strips URL credentials and uses primary URL auth header', async () => {
    envManager.set('SEARXNG_URL', 'https://primary-user:p%40ss@primary.example.com/base;https://secondary.example.com');
    envManager.set('AUTH_USERNAME', 'global-user');
    envManager.set('AUTH_PASSWORD', 'global-pass');

    const mockServer = createMockServer();
    const { mockFetch, getCapturedUrl, getCapturedOptions } = createCapturingMockFetch();

    fetchMocker.mock(async (url, options) => {
      await mockFetch(url, options);
      return createMockFetch({ json: ['type', ['typescript']] })(url, options);
    });

    const suggestions = await performSearchSuggestions(mockServer as any, 'type');

    const capturedUrl = getCapturedUrl();
    const parsedUrl = new URL(capturedUrl);
    const headers = getCapturedOptions()?.headers as Record<string, string>;
    assert.deepEqual(suggestions, ['typescript']);
    assert.equal(parsedUrl.username, '');
    assert.equal(parsedUrl.password, '');
    assert.equal(parsedUrl.hostname, 'primary.example.com');
    assert.equal(parsedUrl.pathname, '/base/autocompleter');
    assert.ok(!capturedUrl.includes('primary-user:p%40ss@'), capturedUrl);
    assert.equal(headers['authorization'], `Basic ${Buffer.from('primary-user:p@ss').toString('base64')}`);

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('autocompleter uses global auth fallback when primary URL has no userinfo', async () => {
    envManager.set('SEARXNG_URL', 'https://primary.example.com');
    envManager.set('AUTH_USERNAME', 'global-user');
    envManager.set('AUTH_PASSWORD', 'global-pass');

    const mockServer = createMockServer();
    const { mockFetch, getCapturedOptions } = createCapturingMockFetch();

    fetchMocker.mock(async (url, options) => {
      await mockFetch(url, options);
      return createMockFetch({ json: ['type', ['typescript']] })(url, options);
    });

    await performSearchSuggestions(mockServer as any, 'type');

    const headers = getCapturedOptions()?.headers as Record<string, string>;
    assert.equal(headers['authorization'], `Basic ${Buffer.from('global-user:global-pass').toString('base64')}`);

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('language=all omits lang parameter', async () => {
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');
    const mockServer = createMockServer();
    const { mockFetch, getCapturedUrl } = createCapturingMockFetch();

    fetchMocker.mock(async (url, options) => {
      await mockFetch(url, options);
      return createMockFetch({ json: ['type', ['typescript']] })(url, options);
    });

    await performSearchSuggestions(mockServer as any, 'type', 'all');

    const url = new URL(getCapturedUrl());
    assert.equal(url.searchParams.get('lang'), null);

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('autocompleter request uses search proxy dispatcher when configured', async () => {
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');
    envManager.set('SEARCH_HTTP_PROXY', 'http://proxy.example.com:8080');
    const mockServer = createMockServer();
    const { mockFetch, getCapturedOptions } = createCapturingMockFetch();

    fetchMocker.mock(async (url, options) => {
      await mockFetch(url, options);
      return createMockFetch({ json: ['type', ['typescript']] })(url, options);
    });

    await performSearchSuggestions(mockServer as any, 'type');

    assert.ok((getCapturedOptions() as any)?.dispatcher, 'expected search dispatcher in fetch options');

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('autocompleter request includes User-Agent header when USER_AGENT is set', async () => {
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');
    envManager.delete('SEARCH_USER_AGENT');
    envManager.set('USER_AGENT', 'MyBot/1.0');
    const mockServer = createMockServer();
    const { mockFetch, getCapturedOptions } = createCapturingMockFetch();

    fetchMocker.mock(async (url, options) => {
      await mockFetch(url, options);
      return createMockFetch({ json: ['type', ['typescript']] })(url, options);
    });

    await performSearchSuggestions(mockServer as any, 'type');

    const headers = getCapturedOptions()?.headers as Record<string, string>;
    assert.equal(headers?.['user-agent'], 'MyBot/1.0');

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('autocompleter request uses SEARCH_USER_AGENT over USER_AGENT', async () => {
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');
    envManager.set('SEARCH_USER_AGENT', 'SearchBot/2.0');
    envManager.set('USER_AGENT', 'GlobalBot/1.0');
    const mockServer = createMockServer();
    const { mockFetch, getCapturedOptions } = createCapturingMockFetch();

    fetchMocker.mock(async (url, options) => {
      await mockFetch(url, options);
      return createMockFetch({ json: ['type', ['typescript']] })(url, options);
    });

    try {
      await performSearchSuggestions(mockServer as any, 'type');

      const headers = getCapturedOptions()?.headers as Record<string, string>;
      assert.equal(headers?.['user-agent'], 'SearchBot/2.0');
    } finally {
      fetchMocker.restore();
      envManager.restore();
    }
  }, results);

  await testFunction('autocompleter request omits User-Agent header when USER_AGENT is unset', async () => {
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');
    envManager.delete('SEARCH_USER_AGENT');
    envManager.delete('USER_AGENT');
    const mockServer = createMockServer();
    const { mockFetch, getCapturedOptions } = createCapturingMockFetch();

    fetchMocker.mock(async (url, options) => {
      await mockFetch(url, options);
      return createMockFetch({ json: ['type', ['typescript']] })(url, options);
    });

    await performSearchSuggestions(mockServer as any, 'type');

    const headers = (getCapturedOptions()?.headers || {}) as Record<string, string>;
    assert.ok(!headers['user-agent'], `Expected no User-Agent header`);

    fetchMocker.restore();
    envManager.restore();
  }, results);

  printTestSummary(results, 'Suggestions Module');
  return results;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  runTests().then(results => {
    process.exit(results.failed > 0 ? 1 : 0);
  }).catch(console.error);
}

export { runTests };
