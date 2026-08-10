#!/usr/bin/env tsx

/**
 * Unit Tests: instance-info.ts
 *
 * Tests for SearXNG /config capability discovery.
 */

import { strict as assert } from 'node:assert';
import { fileURLToPath } from 'node:url';
import { fetchInstanceInfo, getEngineTimeRangeSupport, clearInstanceInfoCacheForTests } from '../../src/instance-info.js';
import { testFunction, createTestResults, printTestSummary } from '../helpers/test-utils.js';
import { createMockServer, createMockServerWithTracking } from '../helpers/mock-server.js';
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
      { name: 'google', categories: ['general'], disabled: false, time_range_support: true },
      { name: 'bing', categories: ['general'], disabled: true, time_range_support: true },
      { name: 'brave', categories: ['news'], disabled: false, time_range_support: false },
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

function makeSecondaryConfig() {
  return {
    categories: ['general', 'images'],
    engines: [
      { name: 'google', categories: ['general'], disabled: false },
      { name: 'qwant', categories: ['general'], disabled: false },
      { name: 'bing', categories: ['general'], disabled: true },
      { name: 'flickr', categories: ['images'], disabled: false },
    ],
    default_locale: 'fr',
    default_theme: 'oscar',
    search: { safe_search: 2 },
    plugins: ['Secondary plugin'],
  };
}

function configResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, { status: 200, ...init });
}

function streamedConfigResponse(chunks: Uint8Array[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
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
    assert.deepEqual(payload.instancesReachable, ['https://test-searx.example.com']);
    assert.equal(payload.sourceUrl, undefined);
    assert.deepEqual(payload.categories.common, ['general', 'news']);
    assert.deepEqual(payload.categories.available, ['general', 'news']);
    assert.deepEqual(payload.engines.common.enabled, ['brave', 'google']);
    assert.deepEqual(payload.engines.available.enabled, ['brave', 'google']);
    assert.deepEqual(payload.engines.common.disabled, ['bing']);
    assert.deepEqual(payload.engines.available.disabled, ['bing']);
    assert.equal(payload.defaults.safesearch, 1);
    assert.equal(payload.defaults.theme, 'simple');
    assert.deepEqual(payload.plugins, ['Hash plugin']);

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('resolves engine time-range support from cached /config', async () => {
    clearInstanceInfoCacheForTests();
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');
    const mockServer = createMockServer();
    fetchMocker.mock(createMockFetch({ json: makeConfig() }));

    const support = await getEngineTimeRangeSupport(mockServer as any, ['google', 'brave', 'missing']);

    assert.deepEqual(support, {
      supported: ['google'],
      unsupported: ['brave'],
      unknown: ['missing'],
    });

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
    assert.deepEqual(payload.categories.common, ['general', 'science', 'social media']);
    assert.deepEqual(payload.categories.available, ['general', 'science', 'social media']);
    assert.deepEqual(payload.engines.common.enabled, ['google', 'mastodon', 'semantic scholar']);
    assert.deepEqual(payload.engines.available.enabled, ['google', 'mastodon', 'semantic scholar']);

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('category filter works when /config categories is an array of strings', async () => {
    clearInstanceInfoCacheForTests();
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');
    const mockServer = createMockServer();
    fetchMocker.mock(createMockFetch({ json: makeConfigWithCategoryArray() }));

    const result = JSON.parse(await fetchInstanceInfo(mockServer as any, true, false, 'social media'));

    assert.deepEqual(result.categories.common, ['social media']);
    assert.deepEqual(result.categories.available, ['social media']);
    assert.deepEqual(result.engines.common.enabled, ['mastodon']);
    assert.deepEqual(result.engines.available.enabled, ['mastodon']);

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
    assert.deepEqual(refreshed.categories.common, ['general', 'images', 'news']);
    assert.deepEqual(refreshed.categories.available, ['general', 'images', 'news']);

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
    assert.deepEqual(payload.instancesUnreachable, [{
      sourceUrl: 'https://test-searx.example.com',
      message: 'SearXNG /config is unavailable: HTTP 403 Forbidden',
      status: 403,
    }]);

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('category filter returns only matching engines', async () => {
    clearInstanceInfoCacheForTests();
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');
    const mockServer = createMockServer();
    fetchMocker.mock(createMockFetch({ json: makeConfig() }));

    const result = JSON.parse(await fetchInstanceInfo(mockServer as any, true, false, 'news'));

    assert.deepEqual(result.categories.common, ['news']);
    assert.deepEqual(result.categories.available, ['news']);
    assert.deepEqual(result.engines.common.enabled, ['brave']);
    assert.deepEqual(result.engines.available.enabled, ['brave']);
    assert.equal(result.engines.common.disabled, undefined);
    assert.equal(result.engines.available.disabled, undefined);

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('includeDisabled=false omits disabled engines', async () => {
    clearInstanceInfoCacheForTests();
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');
    const mockServer = createMockServer();
    fetchMocker.mock(createMockFetch({ json: makeConfig() }));

    const result = JSON.parse(await fetchInstanceInfo(mockServer as any, true, false));

    assert.deepEqual(result.engines.common.enabled, ['brave', 'google']);
    assert.deepEqual(result.engines.available.enabled, ['brave', 'google']);
    assert.equal(result.engines.common.disabled, undefined);
    assert.equal(result.engines.available.disabled, undefined);

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
    assert.equal(url.pathname, '/subpath/config');

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('multi-URL SEARXNG_URL aggregates capabilities from all reachable instances', async () => {
    clearInstanceInfoCacheForTests();
    envManager.set('SEARXNG_URL', 'https://primary.example.com/base;https://secondary.example.com');
    const mockServer = createMockServer();
    const requestedUrls: string[] = [];
    fetchMocker.mock(async (url, options) => {
      requestedUrls.push(url.toString());
      const parsedUrl = new URL(url.toString());
      if (parsedUrl.origin === 'https://secondary.example.com') {
        return createMockFetch({ json: makeSecondaryConfig() })(url, options);
      }
      return createMockFetch({ json: makeConfig() })(url, options);
    });

    const result = JSON.parse(await fetchInstanceInfo(mockServer as any, true, true));

    assert.equal(requestedUrls.length, 2);
    assert.ok(requestedUrls.some((requestedUrl) => new URL(requestedUrl).pathname === '/base/config'));
    assert.deepEqual(result.instancesReachable, ['https://primary.example.com/base', 'https://secondary.example.com']);
    assert.equal(result.sourceUrl, undefined);
    assert.deepEqual(result.categories.common, ['general']);
    assert.deepEqual(result.categories.available, ['general', 'images', 'news']);
    assert.deepEqual(result.engines.common.enabled, ['google']);
    assert.deepEqual(result.engines.available.enabled, ['brave', 'flickr', 'google', 'qwant']);
    assert.deepEqual(result.engines.common.disabled, ['bing']);
    assert.deepEqual(result.engines.available.disabled, ['bing']);

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('unreachable multi-URL instance is negative-cached until refresh retries it', async () => {
    clearInstanceInfoCacheForTests();
    envManager.set('SEARXNG_URL', 'https://up.example.com;https://flaky.example.com');
    const mockServer = createMockServer();
    const requestedUrls: string[] = [];
    let flakyAttempts = 0;
    fetchMocker.mock(async (url, options) => {
      requestedUrls.push(url.toString());
      const parsedUrl = new URL(url.toString());
      if (parsedUrl.origin === 'https://flaky.example.com') {
        flakyAttempts++;
        if (flakyAttempts === 1) {
          throw new Error('temporary outage');
        }
        return createMockFetch({ json: makeSecondaryConfig() })(url, options);
      }
      return createMockFetch({ json: makeConfig() })(url, options);
    });

    const first = JSON.parse(await fetchInstanceInfo(mockServer as any, true));
    const second = JSON.parse(await fetchInstanceInfo(mockServer as any, true));
    const refreshed = JSON.parse(await fetchInstanceInfo(mockServer as any, true, false, undefined, true));

    assert.deepEqual(first.instancesReachable, ['https://up.example.com']);
    assert.deepEqual(first.instancesUnreachable, [{
      sourceUrl: 'https://flaky.example.com',
      message: 'SearXNG /config is unavailable; instance capability discovery could not complete.',
    }]);
    assert.deepEqual(second.instancesReachable, ['https://up.example.com']);
    assert.deepEqual(second.instancesUnreachable, first.instancesUnreachable);
    assert.deepEqual(refreshed.instancesReachable, ['https://up.example.com', 'https://flaky.example.com']);
    assert.equal(refreshed.instancesUnreachable, undefined);
    assert.equal(flakyAttempts, 2, 'failed instance should not be refetched until refresh clears negative cache');
    assert.equal(requestedUrls.filter((requestedUrl) => new URL(requestedUrl).origin === 'https://up.example.com').length, 2);

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('credential-bearing instance URLs are redacted from capability payload', async () => {
    clearInstanceInfoCacheForTests();
    envManager.set('SEARXNG_URL', 'https://user:pass@reachable.example.com;https://user:pass@flaky.example.com');
    const mockServer = createMockServer();
    fetchMocker.mock(async (url, options) => {
      const parsedUrl = new URL(url.toString());
      if (parsedUrl.hostname === 'flaky.example.com') {
        throw new Error('temporary outage');
      }
      return createMockFetch({ json: makeConfig() })(url, options);
    });

    const payload = JSON.parse(await fetchInstanceInfo(mockServer as any, true));
    const serialized = JSON.stringify(payload);

    assert.equal(payload.instancesReachable[0], 'https://reachable.example.com/');
    assert.equal(payload.instancesUnreachable[0].sourceUrl, 'https://flaky.example.com/');
    assert.ok(!serialized.includes('user:pass@'), serialized);
    assert.ok(!serialized.includes('user:'), serialized);
    assert.ok(!serialized.includes(':pass@'), serialized);
    assert.ok(!serialized.includes('pass@'), serialized);

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('/config fetch strips URL credentials and uses per-instance auth header', async () => {
    clearInstanceInfoCacheForTests();
    envManager.set('SEARXNG_URL', 'https://config-user:p%40ss@config-auth.example.com');

    const mockServer = createMockServer();
    const { mockFetch, getCapturedUrl, getCapturedOptions } = createCapturingMockFetch();
    fetchMocker.mock(async (url, options) => {
      await mockFetch(url, options);
      return createMockFetch({ json: makeConfig() })(url, options);
    });

    const payload = JSON.parse(await fetchInstanceInfo(mockServer as any, true));

    const capturedUrl = getCapturedUrl();
    const parsedUrl = new URL(capturedUrl);
    const headers = getCapturedOptions()?.headers as Record<string, string>;
    assert.equal(payload.available, true);
    assert.equal(parsedUrl.username, '');
    assert.equal(parsedUrl.password, '');
    assert.equal(parsedUrl.hostname, 'config-auth.example.com');
    assert.equal(parsedUrl.pathname, '/config');
    assert.ok(!capturedUrl.includes('config-user:p%40ss@'), capturedUrl);
    assert.equal(headers['authorization'], `Basic ${Buffer.from('config-user:p@ss').toString('base64')}`);

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('credential-bearing instance URLs are redacted from unavailable payload', async () => {
    clearInstanceInfoCacheForTests();
    envManager.set('SEARXNG_URL', 'https://user:pass@down-one.example.com;https://user:pass@down-two.example.com');
    const mockServer = createMockServer();
    fetchMocker.mock(async () => {
      throw new Error('config blocked');
    });

    const payload = JSON.parse(await fetchInstanceInfo(mockServer as any, true));
    const serialized = JSON.stringify(payload);

    assert.equal(payload.available, false);
    assert.equal(payload.instancesUnreachable[0].sourceUrl, 'https://down-one.example.com/');
    assert.equal(payload.instancesUnreachable[1].sourceUrl, 'https://down-two.example.com/');
    assert.ok(!serialized.includes('user:pass@'), serialized);
    assert.ok(!serialized.includes('user:'), serialized);
    assert.ok(!serialized.includes(':pass@'), serialized);
    assert.ok(!serialized.includes('pass@'), serialized);

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('config fetch failure log redacts credential-bearing URL from error message', async () => {
    clearInstanceInfoCacheForTests();
    envManager.set('SEARXNG_URL', 'https://user:pass@config-log.example.com');
    const { server, getLoggingCalls } = createMockServerWithTracking();
    fetchMocker.mock(async () => {
      throw new Error('failed to fetch https://user:pass@config-log.example.com/config');
    });

    await fetchInstanceInfo(server as any, true);

    const warningLog = getLoggingCalls()
      .map((call) => call.data?.message)
      .find((message) => typeof message === 'string' && message.includes('SearXNG /config fetch failed'));
    assert.ok(warningLog, 'Expected /config fetch warning log');
    assert.match(warningLog, /^SearXNG \/config fetch failed for https:\/\/config-log\.example\.com\//);
    assert.ok(!warningLog.includes('user:pass@'), warningLog);
    assert.ok(!warningLog.includes('pass'), warningLog);

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

  await testFunction('config request includes User-Agent header when USER_AGENT is set', async () => {
    clearInstanceInfoCacheForTests();
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');
    envManager.delete('SEARCH_USER_AGENT');
    envManager.set('USER_AGENT', 'MyBot/1.0');
    const mockServer = createMockServer();
    const { mockFetch, getCapturedOptions } = createCapturingMockFetch();
    fetchMocker.mock(async (url, options) => {
      await mockFetch(url, options);
      return createMockFetch({ json: makeConfig() })(url, options);
    });

    await fetchInstanceInfo(mockServer as any);

    const headers = getCapturedOptions()?.headers as Record<string, string>;
    assert.equal(headers?.['user-agent'], 'MyBot/1.0');

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('config request uses SEARCH_USER_AGENT over USER_AGENT', async () => {
    clearInstanceInfoCacheForTests();
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');
    envManager.set('SEARCH_USER_AGENT', 'SearchBot/2.0');
    envManager.set('USER_AGENT', 'GlobalBot/1.0');
    const mockServer = createMockServer();
    const { mockFetch, getCapturedOptions } = createCapturingMockFetch();
    fetchMocker.mock(async (url, options) => {
      await mockFetch(url, options);
      return createMockFetch({ json: makeConfig() })(url, options);
    });

    try {
      await fetchInstanceInfo(mockServer as any);

      const headers = getCapturedOptions()?.headers as Record<string, string>;
      assert.equal(headers?.['user-agent'], 'SearchBot/2.0');
    } finally {
      fetchMocker.restore();
      envManager.restore();
    }
  }, results);

  await testFunction('config request omits User-Agent header when USER_AGENT is unset', async () => {
    clearInstanceInfoCacheForTests();
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');
    envManager.delete('SEARCH_USER_AGENT');
    envManager.delete('USER_AGENT');
    const mockServer = createMockServer();
    const { mockFetch, getCapturedOptions } = createCapturingMockFetch();
    fetchMocker.mock(async (url, options) => {
      await mockFetch(url, options);
      return createMockFetch({ json: makeConfig() })(url, options);
    });

    await fetchInstanceInfo(mockServer as any);

    const headers = (getCapturedOptions()?.headers || {}) as Record<string, string>;
    assert.ok(!headers['user-agent'], `Expected no User-Agent header`);

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('/config request includes Basic Auth header when credentials are set', async () => {
    clearInstanceInfoCacheForTests();
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');
    envManager.set('AUTH_USERNAME', 'testuser');
    envManager.set('AUTH_PASSWORD', 'testpass');
    envManager.delete('SEARCH_USER_AGENT');
    envManager.delete('USER_AGENT');

    const mockServer = createMockServer();
    const { mockFetch, getCapturedOptions } = createCapturingMockFetch();
    fetchMocker.mock(async (url, options) => {
      await mockFetch(url, options);
      return createMockFetch({ json: makeConfig() })(url, options);
    });

    await fetchInstanceInfo(mockServer as any);

    const headers = (getCapturedOptions()?.headers || {}) as Record<string, string>;
    assert.ok(headers['authorization'], 'expected Authorization header on /config request');
    assert.ok(headers['authorization'].startsWith('Basic '), 'expected Basic auth scheme');

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('/config request omits Authorization header when credentials are not set', async () => {
    clearInstanceInfoCacheForTests();
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');
    envManager.delete('AUTH_USERNAME');
    envManager.delete('AUTH_PASSWORD');
    envManager.delete('SEARCH_USER_AGENT');
    envManager.delete('USER_AGENT');

    const mockServer = createMockServer();
    const { mockFetch, getCapturedOptions } = createCapturingMockFetch();
    fetchMocker.mock(async (url, options) => {
      await mockFetch(url, options);
      return createMockFetch({ json: makeConfig() })(url, options);
    });

    await fetchInstanceInfo(mockServer as any);

    const headers = (getCapturedOptions()?.headers || {}) as Record<string, string>;
    assert.equal(headers['authorization'], undefined, 'Authorization header should be absent without credentials');

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('accepts a /config response exactly at the configured byte limit', async () => {
    clearInstanceInfoCacheForTests();
    envManager.set('SEARXNG_URL', 'https://exact-limit.example.com');
    const mockServer = createMockServer();
    const body = JSON.stringify(makeConfig());
    envManager.set('SEARXNG_MAX_RESPONSE_BYTES', String(Buffer.byteLength(body)));
    fetchMocker.mock(async () => configResponse(body));

    const payload = JSON.parse(await fetchInstanceInfo(mockServer as any));

    assert.equal(payload.available, true);
    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('returns sanitized unavailable payload and negative-caches a /config response one byte over its limit', async () => {
    clearInstanceInfoCacheForTests();
    envManager.set('SEARXNG_URL', 'https://over-limit.example.com');
    const mockServer = createMockServer();
    const body = JSON.stringify(makeConfig());
    envManager.set('SEARXNG_MAX_RESPONSE_BYTES', String(Buffer.byteLength(body) - 1));
    let attempts = 0;
    fetchMocker.mock(async () => {
      attempts++;
      return streamedConfigResponse([Buffer.from(body)]);
    });

    const first = JSON.parse(await fetchInstanceInfo(mockServer as any));
    const second = JSON.parse(await fetchInstanceInfo(mockServer as any));

    assert.equal(first.available, false);
    assert.equal(first.instancesUnreachable[0].sourceUrl, 'https://over-limit.example.com');
    assert.ok(!JSON.stringify(first).includes(body.slice(0, 16)));
    assert.equal(second.available, false);
    assert.equal(attempts, 1, 'failed oversized response should use the negative cache');
    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('treats partial and malformed streamed /config JSON as unavailable without populating the success cache', async () => {
    clearInstanceInfoCacheForTests();
    envManager.set('SEARXNG_URL', 'https://malformed-config.example.com');
    const mockServer = createMockServer();
    let attempts = 0;
    fetchMocker.mock(async () => {
      attempts++;
      return streamedConfigResponse([Buffer.from('{"categories":')]);
    });

    const first = JSON.parse(await fetchInstanceInfo(mockServer as any));
    const second = JSON.parse(await fetchInstanceInfo(mockServer as any));

    assert.equal(first.available, false);
    assert.equal(second.available, false);
    assert.equal(attempts, 1);
    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('cancels non-success /config response bodies and preserves the HTTP unavailable result when cancellation rejects', async () => {
    clearInstanceInfoCacheForTests();
    envManager.set('SEARXNG_URL', 'https://forbidden-config.example.com');
    const mockServer = createMockServer();
    let cancelAttempts = 0;
    const response = configResponse('not disclosed', { status: 403, statusText: 'Forbidden' });
    Object.defineProperty(response, 'body', {
      value: {
        cancel: async () => {
          cancelAttempts++;
          throw new Error('cleanup failed');
        },
      },
    });
    fetchMocker.mock(async () => response);

    const payload = JSON.parse(await fetchInstanceInfo(mockServer as any));

    assert.equal(cancelAttempts, 1);
    assert.deepEqual(payload.instancesUnreachable, [{
      sourceUrl: 'https://forbidden-config.example.com',
      message: 'SearXNG /config is unavailable: HTTP 403 Forbidden',
      status: 403,
    }]);
    assert.ok(!JSON.stringify(payload).includes('not disclosed'));
    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('resolves one response limit for all configured instances before fanout begins', async () => {
    clearInstanceInfoCacheForTests();
    envManager.set('SEARXNG_URL', 'https://first-limit.example.com;https://second-limit.example.com');
    const mockServer = createMockServer();
    const body = JSON.stringify(makeConfig());
    envManager.set('SEARXNG_MAX_RESPONSE_BYTES', String(Buffer.byteLength(body) - 1));
    let attempts = 0;
    fetchMocker.mock(async () => {
      attempts++;
      if (attempts === 1) {
        envManager.set('SEARXNG_MAX_RESPONSE_BYTES', String(Buffer.byteLength(body) + 1));
      }
      return streamedConfigResponse([Buffer.from(body)]);
    });

    const payload = JSON.parse(await fetchInstanceInfo(mockServer as any));

    assert.equal(payload.available, false);
    assert.equal(attempts, 2);
    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('keeps the fixed request timeout active while a headers-first /config body stalls', async () => {
    clearInstanceInfoCacheForTests();
    envManager.set('SEARXNG_URL', 'https://stalled-config.example.com');
    const mockServer = createMockServer();
    const timeoutDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'timeout');
    let observedSignal: AbortSignal | undefined;
    let attempts = 0;
    const timeoutReason = new Error('bounded test timeout');
    const cancellationReasons: unknown[] = [];
    let responseBody: ReadableStream<Uint8Array> | undefined;
    fetchMocker.mock(async (_url, options) => {
      attempts++;
      observedSignal = options?.signal ?? undefined;
      responseBody = new ReadableStream<Uint8Array>({
        cancel(reason) {
          cancellationReasons.push(reason);
        },
      });
      return new Response(responseBody, { status: 200 });
    });
    Object.defineProperty(AbortSignal, 'timeout', {
      configurable: true,
      value: () => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(timeoutReason), 5);
        return controller.signal;
      },
    });

    try {
      const payload = JSON.parse(await Promise.race([
        fetchInstanceInfo(mockServer as any),
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error('stalled /config response did not become unavailable promptly')), 250);
        }),
      ]));
      const cachedPayload = JSON.parse(await fetchInstanceInfo(mockServer as any));
      assert.ok(observedSignal, 'expected the /config request signal');
      assert.equal(observedSignal.aborted, true);
      assert.equal(payload.available, false);
      assert.equal(cachedPayload.available, false);
      assert.equal(attempts, 1, 'a timed-out response must not populate the successful cache');
      assert.deepEqual(cancellationReasons, [timeoutReason]);
      assert.equal(responseBody?.locked, false, 'the shared reader must release its body lock after cancellation');
    } finally {
      if (timeoutDescriptor) {
        Object.defineProperty(AbortSignal, 'timeout', timeoutDescriptor);
      }
      fetchMocker.restore();
      envManager.restore();
    }
  }, results);

  await testFunction('does not log malformed /config response bytes when JSON parsing fails', async () => {
    clearInstanceInfoCacheForTests();
    envManager.set('SEARXNG_URL', 'https://log-user:log-pass@malformed-log.example.com/opaque?trace=UNSAFE_QUERY_SENTINEL');
    const { server, getLoggingCalls } = createMockServerWithTracking();
    const malformedBodySentinel = 'UNSAFE_CONFIG_BODY_SENTINEL_4c2f';
    const originalJsonParse = JSON.parse;
    fetchMocker.mock(async () => configResponse(`{"broken":"${malformedBodySentinel}"`));
    JSON.parse = ((text: string) => {
      if (text.includes(malformedBodySentinel)) {
        throw new Error(`Unable to parse ${malformedBodySentinel}`);
      }
      return originalJsonParse(text);
    }) as typeof JSON.parse;

    try {
      const payload = await fetchInstanceInfo(server as any);
      const serializedLogs = JSON.stringify(getLoggingCalls());

      assert.equal(JSON.parse(payload).available, false);
      assert.ok(!payload.includes(malformedBodySentinel));
      assert.ok(!serializedLogs.includes(malformedBodySentinel), serializedLogs);
      assert.ok(!serializedLogs.includes('log-user'), serializedLogs);
      assert.ok(!serializedLogs.includes('log-pass'), serializedLogs);
      assert.ok(!serializedLogs.includes('UNSAFE_QUERY_SENTINEL'), serializedLogs);
    } finally {
      JSON.parse = originalJsonParse;
      fetchMocker.restore();
      envManager.restore();
    }
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
