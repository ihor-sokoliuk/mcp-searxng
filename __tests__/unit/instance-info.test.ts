#!/usr/bin/env tsx

/**
 * Unit Tests: instance-info.ts
 *
 * Tests for SearXNG /config capability discovery.
 */

import { strict as assert } from 'node:assert';
import { fileURLToPath } from 'node:url';
import { fetchInstanceInfo, clearInstanceInfoCacheForTests } from '../../src/instance-info.js';
import { testFunction, createTestResults, printTestSummary } from '../helpers/test-utils.js';
import { createMockServer } from '../helpers/mock-server.js';
import { FetchMocker, createMockFetch, createCapturingMockFetch } from '../helpers/mock-fetch.js';
import { EnvManager } from '../helpers/env-utils.js';

const results = createTestResults();
const fetchMocker = new FetchMocker();
const envManager = new EnvManager();

function makeConfig() {
  const config: any = {
    categories: {
      general: {
        engines: {
          google: { disabled: false },
          bing: { disabled: true },
        },
      },
      news: {
        engines: {
          brave: { disabled: false },
        },
      },
    },
    engines: [
      { name: 'google', categories: ['general'], disabled: false },
      { name: 'bing', categories: ['general'], disabled: true },
      { name: 'brave', categories: ['news'], disabled: false },
    ],
    default_locale: 'en',
    locales: { en: 'English', fr: 'French' },
    default_theme: 'simple',
    search: { safe_search: 1 },
    plugins: ['Hash plugin'],
  };
  return config;
}

function makeConfigWithCategoryArray() {
  const config: any = makeConfig();
  config.categories = ['general', 'social media', 'science'];
  config.engines = [
    { name: 'google', categories: ['general'], disabled: false },
    { name: 'semantic scholar', categories: ['science'], disabled: false },
    { name: 'mastodon', category: 'social media', disabled: false },
  ];
  return config;
}

async function runTests() {
  console.log('🧪 Testing: instance-info.ts\n');

  await testFunction('returns formatted instance info when /config is available', async () => {
    clearInstanceInfoCacheForTests();
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');
    const mockServer = createMockServer();
    fetchMocker.mock(createMockFetch({ json: makeConfig() }));

    const result = await fetchInstanceInfo(mockServer as any, true, true);
    const payload = JSON.parse(result);

    assert.equal(payload.available, true);
    assert.deepEqual(payload.categories, ['general', 'news']);
    assert.deepEqual(payload.engines.enabled, ['brave', 'google']);
    assert.deepEqual(payload.engines.disabled, ['bing']);
    assert.equal(payload.defaults.safesearch, 1);
    assert.equal(payload.defaults.theme, 'simple');
    assert.deepEqual(payload.plugins, ['Hash plugin']);

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('returns category names when /config categories is an array of strings', async () => {
    clearInstanceInfoCacheForTests();
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');
    const mockServer = createMockServer();
    fetchMocker.mock(createMockFetch({ json: makeConfigWithCategoryArray() }));

    const result = await fetchInstanceInfo(mockServer as any, true, false);
    const payload = JSON.parse(result);

    assert.equal(payload.available, true);
    assert.deepEqual(payload.categories, ['general', 'science', 'social media']);
    assert.deepEqual(payload.engines.enabled, ['google', 'mastodon', 'semantic scholar']);

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('category filter works when /config categories is an array of strings', async () => {
    clearInstanceInfoCacheForTests();
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');
    const mockServer = createMockServer();
    fetchMocker.mock(createMockFetch({ json: makeConfigWithCategoryArray() }));

    const result = JSON.parse(await fetchInstanceInfo(mockServer as any, true, false, 'social media'));

    assert.deepEqual(result.categories, ['social media']);
    assert.deepEqual(result.engines.enabled, ['mastodon']);

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('second call returns cached result without fetching again', async () => {
    clearInstanceInfoCacheForTests();
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');
    const mockServer = createMockServer();
    let fetchCount = 0;

    fetchMocker.mock(async () => {
      fetchCount++;
      return createMockFetch({ json: makeConfig() })('https://unused.example.com');
    });

    await fetchInstanceInfo(mockServer as any, false);
    await fetchInstanceInfo(mockServer as any, false);

    assert.equal(fetchCount, 1);

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('refresh bypasses the cache and updates categories', async () => {
    clearInstanceInfoCacheForTests();
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');
    const mockServer = createMockServer();
    let fetchCount = 0;

    fetchMocker.mock(async () => {
      fetchCount++;
      const config = makeConfig();
      if (fetchCount === 2) {
        config.categories.images = { engines: {} };
      }
      return createMockFetch({ json: config })('https://unused.example.com');
    });

    await fetchInstanceInfo(mockServer as any, false);
    const refreshed = JSON.parse(await fetchInstanceInfo(mockServer as any, false, false, undefined, true));

    assert.equal(fetchCount, 2);
    assert.deepEqual(refreshed.categories, ['general', 'images', 'news']);

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('returns graceful unavailable payload when /config returns 403', async () => {
    clearInstanceInfoCacheForTests();
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');
    const mockServer = createMockServer();
    fetchMocker.mock(createMockFetch({ ok: false, status: 403, statusText: 'Forbidden', body: 'disabled' }));

    const result = await fetchInstanceInfo(mockServer as any);
    const payload = JSON.parse(result);

    assert.equal(payload.available, false);
    assert.ok(payload.message.includes('/config'));
    assert.equal(payload.status, 403);

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('category filter returns only matching engines', async () => {
    clearInstanceInfoCacheForTests();
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');
    const mockServer = createMockServer();
    fetchMocker.mock(createMockFetch({ json: makeConfig() }));

    const result = JSON.parse(await fetchInstanceInfo(mockServer as any, true, false, 'news'));

    assert.deepEqual(result.categories, ['news']);
    assert.deepEqual(result.engines.enabled, ['brave']);
    assert.equal(result.engines.disabled, undefined);

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('includeDisabled=false omits disabled engines', async () => {
    clearInstanceInfoCacheForTests();
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');
    const mockServer = createMockServer();
    fetchMocker.mock(createMockFetch({ json: makeConfig() }));

    const result = JSON.parse(await fetchInstanceInfo(mockServer as any, true, false));

    assert.deepEqual(result.engines.enabled, ['brave', 'google']);
    assert.equal(result.engines.disabled, undefined);

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('returns unavailable payload when SEARXNG_URL is unset', async () => {
    clearInstanceInfoCacheForTests();
    envManager.delete('SEARXNG_URL');
    const mockServer = createMockServer();
    let fetchCalled = false;
    fetchMocker.mock(async () => {
      fetchCalled = true;
      return createMockFetch({ json: makeConfig() })('https://unused.example.com');
    });

    const result = JSON.parse(await fetchInstanceInfo(mockServer as any));

    assert.equal(result.available, false);
    assert.equal(fetchCalled, false);
    assert.ok(result.message.includes('SEARXNG_URL'));

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('config request uses /config under SEARXNG_URL subpath', async () => {
    clearInstanceInfoCacheForTests();
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com/subpath');
    const mockServer = createMockServer();
    const { mockFetch, getCapturedUrl } = createCapturingMockFetch();
    fetchMocker.mock(async (url, options) => {
      await mockFetch(url, options);
      return createMockFetch({ json: makeConfig() })(url, options);
    });

    await fetchInstanceInfo(mockServer as any);

    const url = new URL(getCapturedUrl());
    assert.ok(url.pathname.includes('/subpath/config'), `Expected /subpath/config, got ${url.pathname}`);

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('config request uses search proxy dispatcher when configured', async () => {
    clearInstanceInfoCacheForTests();
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');
    envManager.set('SEARCH_HTTP_PROXY', 'http://proxy.example.com:8080');
    const mockServer = createMockServer();
    const { mockFetch, getCapturedOptions } = createCapturingMockFetch();
    fetchMocker.mock(async (url, options) => {
      await mockFetch(url, options);
      return createMockFetch({ json: makeConfig() })(url, options);
    });

    await fetchInstanceInfo(mockServer as any);

    assert.ok((getCapturedOptions() as any)?.dispatcher, 'expected search dispatcher in fetch options');

    fetchMocker.restore();
    envManager.restore();
  }, results);

  printTestSummary(results, 'Instance Info Module');
  return results;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  runTests().then(results => {
    process.exit(results.failed > 0 ? 1 : 0);
  }).catch(console.error);
}

export { runTests };
