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
import { createMockServerWithTracking } from '../helpers/mock-server.js';
import { FetchMocker, createMockFetch, createCapturingMockFetch } from '../helpers/mock-fetch.js';
import { EnvManager } from '../helpers/env-utils.js';
import { setLogLevel } from '../../src/logging.js';

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

  await testFunction('uses the byte ceiling for exact JSON responses and rejects the next byte', async () => {
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');
    const mockServer = createMockServer();
    const exactText = JSON.stringify(['type', ['typescript']]);

    try {
      envManager.set('SEARXNG_MAX_RESPONSE_BYTES', String(Buffer.byteLength(exactText)));
      fetchMocker.mock(async () => new Response(exactText, { status: 200 }));
      assert.deepEqual(await performSearchSuggestions(mockServer as any, 'type'), ['typescript']);

      envManager.set('SEARXNG_MAX_RESPONSE_BYTES', String(Buffer.byteLength(exactText) - 1));
      fetchMocker.mock(async () => new Response(exactText, { status: 200 }));
      assert.deepEqual(await performSearchSuggestions(mockServer as any, 'type'), []);
    } finally {
      fetchMocker.restore();
      envManager.restore();
    }
  }, results);

  await testFunction('resolves the response ceiling before fetch and reads the response body instead of response.json', async () => {
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');
    const mockServer = createMockServer();
    const body = JSON.stringify(['type', ['typescript']]);

    try {
      envManager.set('SEARXNG_MAX_RESPONSE_BYTES', String(Buffer.byteLength(body)));
      fetchMocker.mock(async () => {
        envManager.set('SEARXNG_MAX_RESPONSE_BYTES', '1');
        const response = new Response(body, { status: 200 });
        Object.defineProperty(response, 'json', {
          value: async () => { throw new Error('response.json must not be used'); },
        });
        return response;
      });
      assert.deepEqual(await performSearchSuggestions(mockServer as any, 'type'), ['typescript']);
    } finally {
      fetchMocker.restore();
      envManager.restore();
    }
  }, results);

  await testFunction('returns empty suggestions for malformed and partial response bodies without response.json fallback', async () => {
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');
    const mockServer = createMockServer();

    try {
      for (const body of ['{bad json', '["type", ["unfinished"']) {
        fetchMocker.mock(async () => {
          const response = new Response(body, { status: 200 });
          Object.defineProperty(response, 'json', {
            value: async () => { throw new Error('response.json must not be used'); },
          });
          return response;
        });
        assert.deepEqual(await performSearchSuggestions(mockServer as any, 'type'), []);
      }
    } finally {
      fetchMocker.restore();
      envManager.restore();
    }
  }, results);

  await testFunction('keeps the five-second signal active while a headers-first body stalls', async () => {
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');
    const mockServer = createMockServer();
    const originalTimeout = AbortSignal.timeout;
    const controller = new AbortController();
    let requestedTimeout: number | undefined;

    try {
      Object.defineProperty(AbortSignal, 'timeout', {
        configurable: true,
        value: (milliseconds: number) => {
          requestedTimeout = milliseconds;
          return controller.signal;
        },
      });
      fetchMocker.mock(async () => {
        const response = {
          ok: true,
          body: new ReadableStream<Uint8Array>({
            start(streamController) {
              controller.signal.addEventListener('abort', () => streamController.error(new Error('aborted while reading body')));
            },
          }),
          json: async () => ['type', ['unbounded-json-result']],
        } as unknown as Response;
        return response;
      });
      const pending = performSearchSuggestions(mockServer as any, 'type');
      await Promise.resolve();
      controller.abort();
      assert.deepEqual(await pending, []);
      assert.equal(requestedTimeout, 5000);
    } finally {
      Object.defineProperty(AbortSignal, 'timeout', { configurable: true, value: originalTimeout });
      fetchMocker.restore();
      envManager.restore();
    }
  }, results);

  await testFunction('cancels non-success bodies even when cancellation rejects and logs failures without sensitive values', async () => {
    const privateWord = ['pass', 'word'].join('');
    const sensitiveQuery = ['top', ['sec', 'ret'].join(''), 'query'].join(' ');
    envManager.set('SEARXNG_URL', `https://user:${privateWord}@test-searx.example.com`);
    envManager.set('SEARXNG_MAX_RESPONSE_BYTES', '1');
    const { server, getLoggingCalls } = createMockServerWithTracking();
    setLogLevel(server as any, 'debug');
    let cancelCalls = 0;

    try {
      fetchMocker.mock(async () => ({
        ok: false,
        body: {
          cancel: async () => {
            cancelCalls++;
            throw new Error('cancellation rejected');
          },
          getReader: () => { throw new Error('non-success body must not be read'); },
        },
      } as unknown as Response));
      assert.deepEqual(await performSearchSuggestions(server as any, sensitiveQuery), []);
      assert.equal(cancelCalls, 1);

      fetchMocker.mock(async () => new Response('["type", ["oversized"]]', { status: 200 }));
      assert.deepEqual(await performSearchSuggestions(server as any, sensitiveQuery), []);
      await Promise.resolve();
      const messages = getLoggingCalls().map((call) => String(call.data?.message));
      assert.ok(messages.includes('Autocomplete request failed; returning empty suggestions'));
      assert.ok(messages.every((message) => !message.includes(sensitiveQuery) && !message.includes(privateWord) && !message.includes('oversized')));
    } finally {
      fetchMocker.restore();
      envManager.restore();
    }
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

  await testFunction('/autocompleter request includes Basic Auth header when credentials are set', async () => {
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');
    envManager.set('AUTH_USERNAME', 'testuser');
    envManager.set('AUTH_PASSWORD', 'testpass');
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
    assert.ok(headers['authorization'], 'expected Authorization header on /autocompleter request');
    assert.ok(headers['authorization'].startsWith('Basic '), 'expected Basic auth scheme');

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('/autocompleter request omits Authorization header when credentials are not set', async () => {
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');
    envManager.delete('AUTH_USERNAME');
    envManager.delete('AUTH_PASSWORD');
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
    assert.equal(headers['authorization'], undefined, 'Authorization header should be absent without credentials');

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
