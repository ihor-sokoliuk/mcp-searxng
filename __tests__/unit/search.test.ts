#!/usr/bin/env tsx

/**
 * Unit Tests: search.ts
 * 
 * Tests for SearXNG search functionality
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { performWebSearch, formatCachedSearchResult, getSearchTimeoutMs } from '../../src/search.js';
import { searchCache } from '../../src/search-cache.js';
import { clearInstanceInfoCacheForTests } from '../../src/instance-info.js';
import {
  clearSearxngInstanceStateForTests,
  recordSearxngInstanceFailure,
} from '../../src/searxng-instances.js';
import { testFunction, createTestResults, printTestSummary } from '../helpers/test-utils.js';
import { createMockServer, createMockServerWithTracking } from '../helpers/mock-server.js';
import { FetchMocker, createMockFetch, createCapturingMockFetch, createAbortableMockFetch } from '../helpers/mock-fetch.js';
import { EnvManager } from '../helpers/env-utils.js';

const results = createTestResults();
const fetchMocker = new FetchMocker();
const envManager = new EnvManager();
const searxngHtmlFixture = readFileSync('__tests__/fixtures/searxng-results.html', 'utf8');

async function withControlledClock(
  fn: (advance: (ms: number) => void) => void | Promise<void>,
): Promise<void> {
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    await fn((ms) => { now += ms; });
  } finally {
    Date.now = realNow;
  }
}

function makeMockSearchResults(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    title: `Result ${index + 1}`,
    content: `Content ${index + 1}`,
    url: `https://example.com/${index + 1}`,
    score: 1 - index * 0.05,
  }));
}

function makeConfigWithEngines() {
  return {
    categories: ['general', 'news', 'social media'],
    engines: [
      { name: 'google', disabled: false },
      { name: 'ddg', disabled: false },
      { name: 'bing', disabled: true },
      { name: 'semantic scholar', disabled: false },
    ],
  };
}

async function runTests() {
  console.log('🧪 Testing: search.ts\n');

  await testFunction('Error handling for missing SEARXNG_URL', async () => {
    envManager.delete('SEARXNG_URL');
    
    const mockServer = createMockServer();
    
    try {
      await performWebSearch(mockServer as any, 'test query');
      assert.fail('Should have thrown configuration error');
    } catch (error: any) {
      assert.ok(error.message.includes('SEARXNG_URL not configured') || error.message.includes('Configuration'));
    }
    
    envManager.restore();
  }, results);

  await testFunction('Error handling for invalid SEARXNG_URL format', async () => {
    envManager.set('SEARXNG_URL', 'not-a-valid-url');
    
    const mockServer = createMockServer();
    
    try {
      await performWebSearch(mockServer as any, 'test query');
      assert.fail('Should have thrown configuration error for invalid URL');
    } catch (error: any) {
      assert.ok(error.message.includes('Configuration Issues') || error.message.includes('invalid format'));
    }
    
    envManager.restore();
  }, results);

  await testFunction('Parameter validation and URL construction', async () => {
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');
    
    const mockServer = createMockServer();
    const { mockFetch, getCapturedUrl } = createCapturingMockFetch();

    fetchMocker.mock(async (url, options) => {
      await mockFetch(url, options);
      throw new Error('MOCK_NETWORK_ERROR');
    });

    try {
      await performWebSearch(mockServer as any, 'test query', 2, 'day', 'en', 1);
    } catch (error: any) {
      // Expected to fail with mock error
    }

    // Verify URL construction
    const url = new URL(getCapturedUrl());
    assert.equal(url.pathname, '/search');
    assert.ok(url.searchParams.get('q') === 'test query');
    assert.ok(url.searchParams.get('pageno') === '2');
    assert.ok(url.searchParams.get('time_range') === 'day');
    assert.ok(url.searchParams.get('language') === 'en');
    assert.ok(url.searchParams.get('safesearch') === '1');
    assert.ok(url.searchParams.get('format') === 'json');

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('URL construction supports week time range', async () => {
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');

    const mockServer = createMockServer();
    const { mockFetch, getCapturedUrl } = createCapturingMockFetch();

    fetchMocker.mock(async (url, options) => {
      await mockFetch(url, options);
      throw new Error('MOCK_NETWORK_ERROR');
    });

    try {
      await performWebSearch(mockServer as any, 'test query', 1, 'week');
    } catch {
      // Expected to fail with mock error
    }

    const url = new URL(getCapturedUrl());
    assert.equal(url.searchParams.get('time_range'), 'week');

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('URL construction with subpath', async () => {
    // Case 1: Subpath without trailing slash
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com/subpath');
    
    const mockServer = createMockServer();
    
    // First run
    let capture = createCapturingMockFetch();
    fetchMocker.mock(async (url, options) => {
      await capture.mockFetch(url, options);
      throw new Error('MOCK_NETWORK_ERROR');
    });

    try {
      await performWebSearch(mockServer as any, 'test query');
    } catch (error: any) {
      // Expected
    }

    let url = new URL(capture.getCapturedUrl());
    assert.equal(url.pathname, '/subpath/search');
    
    fetchMocker.restore();

    // Case 2: Subpath with trailing slash
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com/subpath/');
    
    // Second run
    capture = createCapturingMockFetch();
    fetchMocker.mock(async (url, options) => {
      await capture.mockFetch(url, options);
      throw new Error('MOCK_NETWORK_ERROR');
    });

    try {
      await performWebSearch(mockServer as any, 'test query');
    } catch (error: any) {
      // Expected
    }

    url = new URL(capture.getCapturedUrl());
    assert.equal(url.pathname, '/subpath/search');

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('Authentication header construction', async () => {
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');
    envManager.set('AUTH_USERNAME', 'testuser');
    envManager.set('AUTH_PASSWORD', 'testpass');
    
    const mockServer = createMockServer();
    const { mockFetch, getCapturedOptions } = createCapturingMockFetch();

    fetchMocker.mock(async (url, options) => {
      await mockFetch(url, options);
      throw new Error('MOCK_NETWORK_ERROR');
    });

    try {
      await performWebSearch(mockServer as any, 'test query');
    } catch (error: any) {
      // Expected to fail with mock error
    }

    // Verify auth header was added
    const options = getCapturedOptions();
    assert.ok(options?.headers);
    const headers = options.headers as Record<string, string>;
    assert.equal(headers['authorization'], `Basic ${Buffer.from('testuser:testpass').toString('base64')}`);

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('embedded URL auth overrides global auth for search requests', async () => {
    envManager.set('SEARXNG_URL', 'https://embedded:p%40ss@test-searx.example.com');
    envManager.set('AUTH_USERNAME', 'global-user');
    envManager.set('AUTH_PASSWORD', 'global-pass');

    const mockServer = createMockServer();
    const { mockFetch, getCapturedOptions } = createCapturingMockFetch();

    fetchMocker.mock(async (url, options) => {
      await mockFetch(url, options);
      return createMockFetch({ json: { results: [] } })(url, options);
    });

    await performWebSearch(mockServer as any, 'test query');

    const headers = getCapturedOptions()?.headers as Record<string, string>;
    assert.equal(headers['authorization'], `Basic ${Buffer.from('embedded:p@ss').toString('base64')}`);

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('search fetch URL strips embedded credentials before request', async () => {
    envManager.set('SEARXNG_URL', 'https://user:pass@test-searx.example.com/subpath');

    const mockServer = createMockServer();
    const { mockFetch, getCapturedUrl } = createCapturingMockFetch();

    fetchMocker.mock(async (url, options) => {
      await mockFetch(url, options);
      return createMockFetch({ json: { results: [] } })(url, options);
    });

    await performWebSearch(mockServer as any, 'test query');

    const capturedUrl = getCapturedUrl();
    const parsedUrl = new URL(capturedUrl);
    assert.equal(parsedUrl.username, '');
    assert.equal(parsedUrl.password, '');
    assert.equal(parsedUrl.hostname, 'test-searx.example.com');
    assert.equal(parsedUrl.pathname, '/subpath/search');
    assert.ok(!capturedUrl.includes('user:pass@'), capturedUrl);

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('search request omits Authorization when no credentials are configured', async () => {
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');
    envManager.delete('AUTH_USERNAME');
    envManager.delete('AUTH_PASSWORD');

    const mockServer = createMockServer();
    const { mockFetch, getCapturedOptions } = createCapturingMockFetch();

    fetchMocker.mock(async (url, options) => {
      await mockFetch(url, options);
      return createMockFetch({ json: { results: [] } })(url, options);
    });

    await performWebSearch(mockServer as any, 'test query');

    const headers = (getCapturedOptions()?.headers || {}) as Record<string, string>;
    assert.equal(headers['authorization'], undefined);

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('Server error handling with different status codes', async () => {
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');
    
    const mockServer = createMockServer();
    const statusCodes = [404, 500, 502, 503];
    
    for (const statusCode of statusCodes) {
      const mockFetch = createMockFetch({
        ok: false,
        status: statusCode,
        statusText: `HTTP ${statusCode}`,
        body: `Server error: ${statusCode}`
      });

      fetchMocker.mock(mockFetch);

      try {
        await performWebSearch(mockServer as any, 'test query');
        assert.fail(`Should have thrown server error for status ${statusCode}`);
      } catch (error: any) {
        assert.ok(error.message.includes('Server Error') || error.message.includes(`${statusCode}`));
      }

      fetchMocker.restore();
    }
    
    envManager.restore();
  }, results);

  await testFunction('JSON parsing error handling', async () => {
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');
    
    const mockServer = createMockServer();
    
    // Simulate a real single-use body: once json() consumes it, text() fails.
    // The buggy path (text() after json()) would lose the preview entirely.
    fetchMocker.mock(async () => {
      let bodyConsumed = false;
      return {
        ok: true,
        json: async () => {
          bodyConsumed = true;
          throw new Error('Invalid JSON');
        },
        text: async () => {
          if (bodyConsumed) {
            throw new TypeError('Body is unusable: Body has already been read');
          }
          return 'Invalid JSON response';
        }
      } as any;
    });

    try {
      await performWebSearch(mockServer as any, 'test query');
      assert.fail('Should have thrown JSON parsing error');
    } catch (error: any) {
      assert.equal(error.name, 'MCPSearXNGError');
      // Regression (BUG-008 review): the error must carry the real response
      // preview, not the '[Could not read response text]' placeholder that the
      // body-already-consumed bug produced.
      assert.ok(
        error.message.includes('Invalid JSON response'),
        `expected response preview in error message, got: ${error.message}`
      );
      assert.ok(
        error.message.includes('- json'),
        `expected SearXNG JSON format remediation in error message, got: ${error.message}`
      );
      assert.ok(
        error.message.includes('search.formats'),
        `expected SearXNG JSON format remediation in error message, got: ${error.message}`
      );
      assert.ok(
        error.message.includes('SEARXNG_HTML_FALLBACK=true'),
        `expected HTML fallback remediation in error message, got: ${error.message}`
      );
    }

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('HTML fallback triggers on 403 when enabled and refetches without format=json', async () => {
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');
    envManager.set('SEARXNG_HTML_FALLBACK', 'true');

    const mockServer = createMockServer();
    const requestedUrls: string[] = [];
    fetchMocker.mock(async (url) => {
      requestedUrls.push(url.toString());

      const requestUrl = new URL(url.toString());
      if (requestUrl.pathname.endsWith('/config')) {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({
            categories: ['general'],
            engines: [],
          }),
        } as Response;
      }

      if (requestUrl.searchParams.get('format') === 'json') {
        return {
          ok: false,
          status: 403,
          statusText: 'Forbidden',
          text: async () => 'JSON format is disabled',
        } as Response;
      }

      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => searxngHtmlFixture,
      } as Response;
    });

    const result = await performWebSearch(mockServer as any, 'html query', 2, 'week', 'en', 1, undefined, undefined, 'general', undefined, 'json');
    const payload = JSON.parse(result);

    const searchUrls = requestedUrls.filter((requestedUrl) => new URL(requestedUrl).pathname.endsWith('/search'));
    assert.equal(searchUrls.length, 2);
    const jsonUrl = new URL(searchUrls[0]);
    const htmlUrl = new URL(searchUrls[1]);
    assert.equal(jsonUrl.searchParams.get('format'), 'json');
    assert.equal(htmlUrl.searchParams.get('format'), null);
    assert.equal(htmlUrl.searchParams.get('q'), 'html query');
    assert.equal(htmlUrl.searchParams.get('pageno'), '2');
    assert.equal(htmlUrl.searchParams.get('time_range'), 'week');
    assert.equal(htmlUrl.searchParams.get('language'), 'en');
    assert.equal(htmlUrl.searchParams.get('safesearch'), '1');
    assert.equal(htmlUrl.searchParams.get('categories'), 'general');
    assert.equal(payload.sourceFormat, 'html');
    assert.equal(payload.results.length, 2);
    assert.deepEqual(payload.results[0], {
      title: 'Alpha Result',
      url: 'https://example.com/alpha',
      content: 'Alpha result snippet from a SearXNG simple theme result page.',
    });

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('HTML fallback retry log redacts credential-bearing configured URL', async () => {
    envManager.set('SEARXNG_URL', 'https://user:pass@fallback-log.example.com');
    envManager.set('SEARXNG_HTML_FALLBACK', 'true');

    const { server, getLoggingCalls } = createMockServerWithTracking();
    fetchMocker.mock(async (url) => {
      const requestUrl = new URL(url.toString());

      if (requestUrl.searchParams.get('format') === 'json') {
        return {
          ok: false,
          status: 403,
          statusText: 'Forbidden',
          text: async () => 'JSON format is disabled',
        } as Response;
      }

      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => searxngHtmlFixture,
      } as Response;
    });

    await performWebSearch(server as any, 'fallback log');

    const fallbackLog = getLoggingCalls()
      .map((call) => call.data?.message)
      .find((message) => typeof message === 'string' && message.includes('Retrying search with HTML fallback:'));
    assert.ok(fallbackLog, 'Expected HTML fallback retry log');
    assert.match(fallbackLog, /^Retrying search with HTML fallback: https:\/\/fallback-log\.example\.com\//);
    assert.ok(!fallbackLog.includes('user:pass@'), fallbackLog);
    assert.ok(!fallbackLog.includes('pass'), fallbackLog);

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('HTML fallback triggers on 200 non-JSON body when enabled', async () => {
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');
    envManager.set('SEARXNG_HTML_FALLBACK', 'true');

    const mockServer = createMockServer();
    let fetchCount = 0;
    fetchMocker.mock(async () => {
      fetchCount++;
      if (fetchCount === 1) {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => { throw new Error('Unexpected token < in JSON'); },
          text: async () => '<!doctype html><html><body>JSON disabled</body></html>',
        } as any;
      }

      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => searxngHtmlFixture,
      } as Response;
    });

    const result = await performWebSearch(mockServer as any, 'non json query', 1, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 'json');
    const payload = JSON.parse(result);

    assert.equal(fetchCount, 2);
    assert.equal(payload.sourceFormat, 'html');
    assert.equal(payload.results[1].title, 'Beta Result');
    assert.equal(payload.results[1].url, 'https://example.com/beta');

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('HTML fallback on 200 non-JSON body strips embedded credentials from the refetch URL', async () => {
    envManager.set('SEARXNG_URL', 'https://user:p%40ss@test-searx.example.com');
    envManager.set('SEARXNG_HTML_FALLBACK', 'true');

    const mockServer = createMockServer();
    const fetchedUrls: string[] = [];
    fetchMocker.mock(async (url) => {
      fetchedUrls.push(url.toString());
      if (fetchedUrls.length === 1) {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => { throw new Error('Unexpected token < in JSON'); },
          text: async () => '<!doctype html><html><body>JSON disabled</body></html>',
        } as any;
      }

      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => searxngHtmlFixture,
      } as Response;
    });

    await performWebSearch(mockServer as any, 'non json creds', 1, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 'json');

    assert.equal(fetchedUrls.length, 2);
    // Neither the initial fetch nor the HTML-fallback refetch may carry userinfo —
    // Node's fetch rejects credential-bearing URLs outright.
    for (const fetched of fetchedUrls) {
      assert.equal(new URL(fetched).username, '');
      assert.ok(!fetched.includes('user:p%40ss@'), fetched);
    }

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('403 without HTML fallback enabled returns original error and does not refetch', async () => {
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');
    envManager.delete('SEARXNG_HTML_FALLBACK');

    const mockServer = createMockServer();
    let fetchCount = 0;
    fetchMocker.mock(async () => {
      fetchCount++;
      return {
        ok: false,
        status: 403,
        statusText: 'Forbidden',
        text: async () => 'JSON format is disabled',
      } as Response;
    });

    try {
      await performWebSearch(mockServer as any, 'test query');
      assert.fail('Expected original 403 error');
    } catch (error: any) {
      assert.ok(error.message.includes('403') || error.message.includes('Server Error'));
    }
    assert.equal(fetchCount, 1);

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('401 with HTML fallback enabled returns original error and does not refetch', async () => {
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');
    envManager.set('SEARXNG_HTML_FALLBACK', 'true');

    const mockServer = createMockServer();
    let fetchCount = 0;
    fetchMocker.mock(async () => {
      fetchCount++;
      return {
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        text: async () => 'Authentication required',
      } as Response;
    });

    try {
      await performWebSearch(mockServer as any, 'test query');
      assert.fail('Expected original 401 error');
    } catch (error: any) {
      assert.ok(error.message.includes('401') || error.message.includes('Server Error'));
    }
    assert.equal(fetchCount, 1);

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('HTML fallback text output includes limited metadata note', async () => {
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');
    envManager.set('SEARXNG_HTML_FALLBACK', 'true');

    const mockServer = createMockServer();
    let fetchCount = 0;
    fetchMocker.mock(async () => {
      fetchCount++;
      if (fetchCount === 1) {
        return {
          ok: false,
          status: 404,
          statusText: 'Not Found',
          text: async () => 'JSON endpoint not found',
        } as Response;
      }

      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => searxngHtmlFixture,
      } as Response;
    });

    const result = await performWebSearch(mockServer as any, 'html query');

    assert.ok(result.includes('Note: Results parsed from SearXNG HTML fallback; metadata is limited.'));
    assert.ok(result.includes('Title: Alpha Result'));
    assert.ok(!result.includes('Relevance Score:'));

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('Missing results data error handling', async () => {
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');
    
    const mockServer = createMockServer();
    const mockFetch = createMockFetch({ json: { query: 'test' } });

    fetchMocker.mock(mockFetch);

    try {
      await performWebSearch(mockServer as any, 'test query');
      assert.fail('Should have thrown data error for missing results');
    } catch (error: any) {
      assert.ok(error.message.includes('Data Error') || error.message.includes('results'));
    }

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('Empty results handling', async () => {
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');
    
    const mockServer = createMockServer();
    const mockFetch = createMockFetch({ json: { results: [] } });

    fetchMocker.mock(mockFetch);

    const result = await performWebSearch(mockServer as any, 'test query');
    assert.ok(typeof result === 'string');
    assert.ok(result.includes('No results found'));

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('Successful search with results formatting', async () => {
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');
    
    const mockServer = createMockServer();
    const mockFetch = createMockFetch({
      json: {
        results: [
          {
            title: 'Test Result 1',
            content: 'This is test content 1',
            url: 'https://example.com/1',
            score: 0.95
          },
          {
            title: 'Test Result 2',
            content: 'This is test content 2',
            url: 'https://example.com/2',
            score: 0.87
          }
        ]
      }
    });

    fetchMocker.mock(mockFetch);

    const result = await performWebSearch(mockServer as any, 'test query');
    const lines = result.split('\n');
    assert.ok(typeof result === 'string');
    assert.ok(result.includes('Test Result 1'));
    assert.ok(result.includes('Test Result 2'));
    assert.ok(lines.some((line) => line === 'URL: https://example.com/1'));
    assert.ok(lines.some((line) => line === 'URL: https://example.com/2'));

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('formatCachedSearchResult annotates text and JSON, and never throws on bad JSON', () => {
    // Text: appends the marker.
    assert.equal(formatCachedSearchResult('plain body', 'text'), 'plain body\n\n_Cached result_');

    // Valid JSON: stays parseable and gains cached: true.
    const annotated = JSON.parse(formatCachedSearchResult('{"results":[]}', 'json'));
    assert.deepEqual(annotated.results, []);
    assert.equal(annotated.cached, true);

    // Malformed JSON under a JSON key must not throw — serve it unannotated so a
    // cache hit can never turn a previously successful call into a failure.
    assert.equal(formatCachedSearchResult('not json{', 'json'), 'not json{');
  }, results);

  await testFunction('Second identical search returns cached result without calling fetch', async () => {
    searchCache.clear();
    envManager.set('SEARXNG_URL', 'https://cache.example.com');

    const mockServer = createMockServer();
    let fetchCount = 0;
    fetchMocker.mock(async (url, options) => {
      fetchCount++;
      return createMockFetch({
        json: {
          results: [
            { title: 'Cached Result', content: 'Cached content', url: 'https://example.com/cached', score: 1 },
          ],
        },
      })(url, options);
    });

    const firstResult = await performWebSearch(mockServer as any, 'cache query');
    const secondResult = await performWebSearch(mockServer as any, 'cache query');

    assert.equal(fetchCount, 1);
    assert.ok(firstResult.includes('Cached Result'));
    assert.ok(secondResult.includes('Cached Result'));
    assert.ok(secondResult.endsWith('\n\n_Cached result_'), secondResult);

    fetchMocker.restore();
    envManager.restore();
    searchCache.clear();
  }, results);

  await testFunction('Cached text search includes _Cached result_ suffix', async () => {
    searchCache.clear();
    envManager.set('SEARXNG_URL', 'https://cache-marker.example.com');

    const mockServer = createMockServer();
    fetchMocker.mock(createMockFetch({
      json: {
        results: [
          { title: 'Marker Result', content: 'Marker content', url: 'https://example.com/marker', score: 0.9 },
        ],
      },
    }));

    const firstResult = await performWebSearch(mockServer as any, 'marker query');
    const secondResult = await performWebSearch(mockServer as any, 'marker query');
    const thirdResult = await performWebSearch(mockServer as any, 'marker query');

    const markerCount = (text: string) => text.split('_Cached result_').length - 1;
    assert.ok(!firstResult.includes('_Cached result_'), firstResult);
    assert.equal(markerCount(secondResult), 1);
    assert.equal(markerCount(thirdResult), 1);

    fetchMocker.restore();
    envManager.restore();
    searchCache.clear();
  }, results);

  await testFunction('Cached JSON search remains parseable and includes cached field', async () => {
    searchCache.clear();
    envManager.set('SEARXNG_URL', 'https://cache-json.example.com');

    const mockServer = createMockServer();
    let fetchCount = 0;
    fetchMocker.mock(async (url, options) => {
      fetchCount++;
      return createMockFetch({
        json: {
          query: 'json cache',
          results: [
            { title: 'JSON Result', content: 'JSON content', url: 'https://example.com/json', score: 0.8 },
          ],
        },
      })(url, options);
    });

    const firstPayload = JSON.parse(await performWebSearch(mockServer as any, 'json cache', 1, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 'json'));
    const secondResult = await performWebSearch(mockServer as any, 'json cache', 1, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 'json');
    const secondPayload = JSON.parse(secondResult);

    assert.equal(fetchCount, 1);
    assert.equal(firstPayload.cached, undefined);
    assert.equal(secondPayload.cached, true);
    assert.ok(!secondResult.includes('_Cached result_'), secondResult);

    fetchMocker.restore();
    envManager.restore();
    searchCache.clear();
  }, results);

  await testFunction('Expired cached search hits fetch again', async () => withControlledClock((advance) => {
    searchCache.clear();
    envManager.set('SEARXNG_URL', 'https://cache-expiry.example.com');

    const mockServer = createMockServer();
    let fetchCount = 0;
    fetchMocker.mock(async (url, options) => {
      fetchCount++;
      return createMockFetch({
        json: {
          results: [
            {
              title: `Fresh Result ${fetchCount}`,
              content: 'Fresh content',
              url: `https://example.com/fresh-${fetchCount}`,
              score: 1,
            },
          ],
        },
      })(url, options);
    });

    return (async () => {
      searchCache.set('searxng_web_search', {
        query: 'unused warmup',
      }, 'unused');

      await performWebSearch(mockServer as any, 'expiry query');
      advance(86400001);
      const result = await performWebSearch(mockServer as any, 'expiry query');

      assert.equal(fetchCount, 2);
      assert.ok(result.includes('Fresh Result 2'), result);
      assert.ok(!result.includes('_Cached result_'), result);

      fetchMocker.restore();
      envManager.restore();
      searchCache.clear();
    })();
  }), results);

  await testFunction('Different effective args do not share cached results', async () => {
    searchCache.clear();
    clearInstanceInfoCacheForTests();
    clearSearxngInstanceStateForTests();
    envManager.set('SEARXNG_URL', 'https://cache-a.example.com;https://cache-b.example.com');
    envManager.set('SEARXNG_FANOUT', 'false');
    envManager.set('SEARXNG_DEFAULT_LANGUAGE', 'en');
    envManager.set('SEARXNG_DEFAULT_SAFESEARCH', '1');
    envManager.set('SEARXNG_MAX_RESULT_CHARS', '30');

    const mockServer = createMockServer();
    let searchFetchCount = 0;
    fetchMocker.mock(async (url, options) => {
      const parsedUrl = new URL(url.toString());
      if (parsedUrl.pathname.endsWith('/config')) {
        return createMockFetch({ json: makeConfigWithEngines() })(url, options);
      }

      searchFetchCount++;
      return createMockFetch({
        json: {
          query: parsedUrl.searchParams.get('q'),
          results: [
            {
              title: `Variant ${searchFetchCount}`,
              content: `Variant content ${searchFetchCount}`,
              url: `https://example.com/variant-${searchFetchCount}`,
              score: 1,
            },
          ],
        },
      })(url, options);
    });

    await performWebSearch(mockServer as any, 'variant query', 1, undefined, undefined, undefined, undefined, 1, 'News', undefined, 'text');
    await performWebSearch(mockServer as any, 'variant query', 1, undefined, undefined, undefined, undefined, 2, 'News', undefined, 'text');
    await performWebSearch(mockServer as any, 'variant query', 1, undefined, undefined, undefined, undefined, 2, 'News', undefined, 'json');
    await performWebSearch(mockServer as any, 'variant query', 1, undefined, 'fr', undefined, undefined, 2, 'News', undefined, 'json');
    await performWebSearch(mockServer as any, 'variant query', 1, undefined, 'fr', 2, undefined, 2, 'News', 'Google', 'json');
    envManager.set('SEARXNG_FANOUT', 'true');
    await performWebSearch(mockServer as any, 'variant query', 1, undefined, 'fr', 2, undefined, 2, 'News', 'Google', 'json');
    envManager.set('SEARXNG_URL', 'https://cache-c.example.com;https://cache-d.example.com');
    await performWebSearch(mockServer as any, 'variant query', 1, undefined, 'fr', 2, undefined, 2, 'News', 'Google', 'json');

    assert.equal(searchFetchCount, 9);

    fetchMocker.restore();
    envManager.restore();
    searchCache.clear();
    clearInstanceInfoCacheForTests();
    clearSearxngInstanceStateForTests();
  }, results);

  await testFunction('min_score filters out lower relevance results', async () => {
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');

    const mockServer = createMockServer();
    const mockFetch = createMockFetch({
      json: {
        results: [
          {
            title: 'High Score Result',
            content: 'Strong match',
            url: 'https://example.com/high',
            score: 0.92
          },
          {
            title: 'Low Score Result',
            content: 'Weak match',
            url: 'https://example.com/low',
            score: 0.31
          }
        ]
      }
    });

    fetchMocker.mock(mockFetch);

    const result = await performWebSearch(mockServer as any, 'test query', 1, undefined, 'all', undefined, 0.5);
    assert.ok(result.includes('High Score Result'));
    assert.ok(!result.includes('Low Score Result'));

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('min_score returns no-results message when all results are filtered', async () => {
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');

    const mockServer = createMockServer();
    const mockFetch = createMockFetch({
      json: {
        results: [
          {
            title: 'Low Score Result',
            content: 'Weak match',
            url: 'https://example.com/low',
            score: 0.2
          }
        ]
      }
    });

    fetchMocker.mock(mockFetch);

    const result = await performWebSearch(mockServer as any, 'test query', 1, undefined, 'all', undefined, 0.8);
    assert.ok(result.includes('No results found'));

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('num_results limits formatted results after min_score filtering', async () => {
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');

    const mockServer = createMockServer();
    const mockFetch = createMockFetch({
      json: {
        results: [
          { title: 'Low Score Result', content: 'Filtered first', url: 'https://example.com/low', score: 0.1 },
          ...makeMockSearchResults(5),
        ]
      }
    });

    fetchMocker.mock(mockFetch);

    const result = await performWebSearch(mockServer as any, 'test query', 1, undefined, 'all', undefined, 0.5, 3);
    assert.ok(!result.includes('Low Score Result'));
    assert.ok(result.includes('Result 1'));
    assert.ok(result.includes('Result 2'));
    assert.ok(result.includes('Result 3'));
    assert.ok(!result.includes('Result 4'));

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('SEARXNG_MAX_RESULTS caps results when num_results is omitted', async () => {
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');
    envManager.set('SEARXNG_MAX_RESULTS', '5');

    const mockServer = createMockServer();
    fetchMocker.mock(createMockFetch({ json: { results: makeMockSearchResults(10) } }));

    const result = await performWebSearch(mockServer as any, 'test query');
    assert.ok(result.includes('Result 5'));
    assert.ok(!result.includes('Result 6'));

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('SEARXNG_MAX_RESULTS is an operator ceiling over num_results', async () => {
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');
    envManager.set('SEARXNG_MAX_RESULTS', '5');

    const mockServer = createMockServer();
    fetchMocker.mock(createMockFetch({ json: { results: makeMockSearchResults(10) } }));

    const result = await performWebSearch(mockServer as any, 'test query', 1, undefined, 'all', undefined, undefined, 10);
    assert.ok(result.includes('Result 5'));
    assert.ok(!result.includes('Result 6'));

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('Invalid SEARXNG_MAX_RESULTS is ignored', async () => {
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');
    envManager.set('SEARXNG_MAX_RESULTS', 'not-a-number');

    const mockServer = createMockServer();
    fetchMocker.mock(createMockFetch({ json: { results: makeMockSearchResults(4) } }));

    const result = await performWebSearch(mockServer as any, 'test query');
    assert.ok(result.includes('Result 4'));

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('Omitted num_results and unset SEARXNG_MAX_RESULTS preserves all results', async () => {
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');
    envManager.delete('SEARXNG_MAX_RESULTS');

    const mockServer = createMockServer();
    fetchMocker.mock(createMockFetch({ json: { results: makeMockSearchResults(6) } }));

    const result = await performWebSearch(mockServer as any, 'test query');
    assert.ok(result.includes('Result 6'));

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('SEARXNG_MAX_RESULT_CHARS truncates long result content only', async () => {
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');
    envManager.set('SEARXNG_MAX_RESULT_CHARS', '10');

    const mockServer = createMockServer();
    const mockFetch = createMockFetch({
      json: {
        results: [
          {
            title: 'Long title should stay intact',
            content: 'abcdefghijklmnopqrstuvwxyz',
            url: 'https://example.com/long-url-that-stays-intact',
            score: 1,
          },
        ],
      },
    });
    fetchMocker.mock(mockFetch);

    const result = await performWebSearch(mockServer as any, 'test query');
    const lines = result.split('\n');
    assert.ok(result.includes('Title: Long title should stay intact'));
    assert.ok(result.includes('Description: abcdefghij…'));
    assert.ok(lines.some((line) => line === 'URL: https://example.com/long-url-that-stays-intact'));
    assert.ok(!result.includes('Description: abcdefghijklmnopqrstuvwxyz'));

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('SEARXNG_MAX_RESULT_CHARS leaves short content unchanged', async () => {
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');
    envManager.set('SEARXNG_MAX_RESULT_CHARS', '100');

    const mockServer = createMockServer();
    const mockFetch = createMockFetch({
      json: {
        results: [
          {
            title: 'Short result',
            content: 'short content',
            url: 'https://example.com/short',
            score: 1,
          },
        ],
      },
    });
    fetchMocker.mock(mockFetch);

    const result = await performWebSearch(mockServer as any, 'test query');
    assert.ok(result.includes('Description: short content'));
    assert.ok(!result.includes('short content…'));

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('Invalid SEARXNG_MAX_RESULT_CHARS is ignored', async () => {
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');
    envManager.set('SEARXNG_MAX_RESULT_CHARS', 'not-a-number');

    const mockServer = createMockServer();
    const mockFetch = createMockFetch({
      json: {
        results: [
          {
            title: 'Untruncated result',
            content: 'abcdefghijklmnopqrstuvwxyz',
            url: 'https://example.com/untruncated',
            score: 1,
          },
        ],
      },
    });
    fetchMocker.mock(mockFetch);

    const result = await performWebSearch(mockServer as any, 'test query');
    assert.ok(result.includes('Description: abcdefghijklmnopqrstuvwxyz'));

    fetchMocker.restore();
    envManager.restore();
  }, results);

  // A NaN/non-positive timeout makes setTimeout(abort, ms) fire on the next tick,
  // aborting every search. These assert the parser guards it. Tested directly
  // because the mock fetch resolves on a microtask and ignores the abort signal,
  // so an end-to-end search can't distinguish the bug from the fix (BUG-013).
  await testFunction('getSearchTimeoutMs falls back to default for non-numeric value', () => {
    envManager.set('SEARXNG_TIMEOUT_MS', 'abc');
    const mockServer = createMockServer();
    assert.equal(getSearchTimeoutMs(mockServer as any), 10000);
    envManager.restore();
  }, results);

  await testFunction('getSearchTimeoutMs falls back to default for non-positive value', () => {
    envManager.set('SEARXNG_TIMEOUT_MS', '-5');
    const mockServer = createMockServer();
    assert.equal(getSearchTimeoutMs(mockServer as any), 10000);
    envManager.restore();
  }, results);

  await testFunction('getSearchTimeoutMs falls back to default for a unit-suffixed value', () => {
    // parseInt("10s") would be 10 (a 10ms timeout) — Number() rejects it.
    envManager.set('SEARXNG_TIMEOUT_MS', '10s');
    const mockServer = createMockServer();
    assert.equal(getSearchTimeoutMs(mockServer as any), 10000);
    envManager.restore();
  }, results);

  await testFunction('getSearchTimeoutMs falls back to default for a decimal value', () => {
    envManager.set('SEARXNG_TIMEOUT_MS', '1.5');
    const mockServer = createMockServer();
    assert.equal(getSearchTimeoutMs(mockServer as any), 10000);
    envManager.restore();
  }, results);

  await testFunction('getSearchTimeoutMs falls back to default above the setTimeout ceiling', () => {
    // > 2^31-1 ms: Node clamps setTimeout to 1 ms, so treat it as invalid.
    envManager.set('SEARXNG_TIMEOUT_MS', '99999999999');
    const mockServer = createMockServer();
    assert.equal(getSearchTimeoutMs(mockServer as any), 10000);
    envManager.restore();
  }, results);

  await testFunction('getSearchTimeoutMs honors a valid value', () => {
    envManager.set('SEARXNG_TIMEOUT_MS', '5000');
    const mockServer = createMockServer();
    assert.equal(getSearchTimeoutMs(mockServer as any), 5000);
    envManager.restore();
  }, results);

  await testFunction('getSearchTimeoutMs warns on invalid value', () => {
    envManager.set('SEARXNG_TIMEOUT_MS', 'abc');
    const { server, getLoggingCalls } = createMockServerWithTracking();
    getSearchTimeoutMs(server as any);
    const warning = getLoggingCalls().find(
      (call) => call.level === 'warning'
        && typeof call.data?.message === 'string'
        && call.data.message.includes('Ignoring invalid SEARXNG_TIMEOUT_MS="abc"'),
    );
    assert.ok(warning, 'Expected a warning for invalid SEARXNG_TIMEOUT_MS');
    envManager.restore();
  }, results);

  await testFunction('User-Agent header added when USER_AGENT env var is set', async () => {
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');
    envManager.delete('SEARCH_USER_AGENT');
    envManager.set('USER_AGENT', 'MyCustomBot/1.0');

    const mockServer = createMockServer();
    const { mockFetch, getCapturedOptions } = createCapturingMockFetch();

    fetchMocker.mock(async (url, options) => {
      await mockFetch(url, options);
      throw new Error('MOCK_STOP');
    });

    try {
      await performWebSearch(mockServer as any, 'test query');
    } catch {
      // expected
    }

    const options = getCapturedOptions();
    const headers = options?.headers as Record<string, string>;
    assert.ok(headers?.['user-agent'] === 'MyCustomBot/1.0', `Expected User-Agent header, got: ${JSON.stringify(headers)}`);

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('SEARCH_USER_AGENT overrides USER_AGENT for search requests', async () => {
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');
    envManager.set('SEARCH_USER_AGENT', 'SearchBot/2.0');
    envManager.set('USER_AGENT', 'GlobalBot/1.0');

    const mockServer = createMockServer();
    const { mockFetch, getCapturedOptions } = createCapturingMockFetch();

    fetchMocker.mock(async (url, options) => {
      await mockFetch(url, options);
      throw new Error('MOCK_STOP');
    });

    try {
      try {
        await performWebSearch(mockServer as any, 'test query');
      } catch {
        // expected
      }

      const options = getCapturedOptions();
      const headers = options?.headers as Record<string, string>;
      assert.equal(headers?.['user-agent'], 'SearchBot/2.0');
    } finally {
      fetchMocker.restore();
      envManager.restore();
    }
  }, results);

  await testFunction('User-Agent header absent when USER_AGENT env var not set', async () => {
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');
    envManager.delete('SEARCH_USER_AGENT');
    envManager.delete('USER_AGENT');

    const mockServer = createMockServer();
    const { mockFetch, getCapturedOptions } = createCapturingMockFetch();

    fetchMocker.mock(async (url, options) => {
      await mockFetch(url, options);
      throw new Error('MOCK_STOP');
    });

    try {
      await performWebSearch(mockServer as any, 'test query');
    } catch {
      // expected
    }

    const options = getCapturedOptions();
    const headers = (options?.headers || {}) as Record<string, string>;
    assert.ok(!headers['user-agent'], `Expected no User-Agent header`);

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('response.text() failure during server error path uses fallback string', async () => {
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');

    const mockServer = createMockServer();
    fetchMocker.mock(async () => ({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: async () => { throw new Error('text() failed'); }
    } as any));

    try {
      await performWebSearch(mockServer as any, 'test query');
      assert.fail('Expected server error');
    } catch (error: any) {
      assert.ok(error.message.includes('500') || error.message.includes('Server Error'));
    }

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('response.text() failure during JSON parse error uses fallback string', async () => {
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');

    const mockServer = createMockServer();
    fetchMocker.mock(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => { throw new Error('JSON parse failed'); },
      text: async () => { throw new Error('text() also failed'); }
    } as any));

    try {
      await performWebSearch(mockServer as any, 'test query');
      assert.fail('Expected JSON error');
    } catch (error: any) {
      assert.ok(error.name === 'MCPSearXNGError' || error.message.includes('JSON'));
    }

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('Proxy dispatcher set when HTTP_PROXY configured', async () => {
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');
    envManager.set('HTTP_PROXY', 'http://proxy.example.com:8080');

    const mockServer = createMockServer();
    let capturedOptions: any;
    fetchMocker.mock(async (_url, options) => {
      capturedOptions = options;
      throw new Error('MOCK_STOP');
    });

    try {
      await performWebSearch(mockServer as any, 'test query');
    } catch {
      // expected
    }

    assert.ok(capturedOptions?.dispatcher, 'Expected dispatcher to be set when proxy configured');

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('Timeout fires when fetch never resolves (AbortError wrapped as network error)', async () => {
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');
    envManager.set('SEARXNG_TIMEOUT_MS', '100');

    const mockServer = createMockServer();
    // createAbortableMockFetch(50000) — resolves only after 50 s, but honours AbortSignal immediately
    fetchMocker.mock(createAbortableMockFetch(50000));

    const start = Date.now();
    try {
      await performWebSearch(mockServer as any, 'timeout test');
      assert.fail('Expected search to reject due to timeout');
    } catch (error: any) {
      const elapsed = Date.now() - start;
      // Should abort well within 2 s (timeout is 100 ms)
      assert.ok(elapsed < 2000, `Expected abort within 2 s, took ${elapsed} ms`);
      // Error is either an AbortError or a network error wrapping it
      const isAbortOrNetwork =
        error.name === 'AbortError' ||
        error.name === 'MCPSearXNGError' ||
        (typeof error.message === 'string' && (
          error.message.includes('abort') ||
          error.message.includes('Abort') ||
          error.message.includes('Network') ||
          error.message.includes('network') ||
          error.message.includes('timed out') ||
          error.message.includes('timeout')
        ));
      assert.ok(isAbortOrNetwork, `Unexpected error: ${error.name}: ${error.message}`);
    }

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('read-only error message (aborted request) does not throw a secondary TypeError', async () => {
    clearSearxngInstanceStateForTests();
    envManager.set('SEARXNG_URL', 'https://user:pass@abort.example.com');

    const mockServer = createMockServer();
    fetchMocker.mock(async () => {
      throw new DOMException('This operation was aborted', 'AbortError');
    });

    try {
      await performWebSearch(mockServer as any, 'abort');
      assert.fail('Expected a handled network error');
    } catch (error: any) {
      assert.ok(!/only a getter|set property message/.test(error.message), error.message);
      assert.match(error.message, /^🌐 Network Error:/);
      assert.ok(!error.message.includes('user:pass@'), error.message);
    }

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('SEARXNG_TIMEOUT_MS env override is respected (50 ms fires before 500 ms mock)', async () => {
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');
    envManager.set('SEARXNG_TIMEOUT_MS', '50');

    const mockServer = createMockServer();
    // Mock resolves via its own 500 ms timer; signal should abort it first
    fetchMocker.mock(createAbortableMockFetch(500));

    const start = Date.now();
    try {
      await performWebSearch(mockServer as any, 'env override test');
      assert.fail('Expected search to reject due to timeout');
    } catch (error: any) {
      const elapsed = Date.now() - start;
      // 50 ms timeout should fire well before the 500 ms mock delay
      assert.ok(elapsed < 400, `Expected abort within 400 ms, took ${elapsed} ms`);
    }

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('Successful response within timeout completes normally', async () => {
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');
    envManager.set('SEARXNG_TIMEOUT_MS', '5000');

    const mockServer = createMockServer();
    const mockFetch = createMockFetch({
      json: {
        results: [
          {
            title: 'Fast Result',
            content: 'Returned before timeout',
            url: 'https://example.com/fast',
            score: 0.9
          }
        ]
      }
    });

    fetchMocker.mock(mockFetch);

    const result = await performWebSearch(mockServer as any, 'fast query');
    assert.ok(typeof result === 'string');
    assert.ok(result.includes('Fast Result'));

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('categories="news" adds categories=news to SearXNG request URL', async () => {
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');

    const mockServer = createMockServer();
    const { mockFetch, getCapturedUrl } = createCapturingMockFetch();

    fetchMocker.mock(async (url, options) => {
      await mockFetch(url, options);
      throw new Error('MOCK_STOP');
    });

    try {
      await performWebSearch(mockServer as any, 'test query', 1, undefined, undefined, undefined, undefined, undefined, 'news');
    } catch {
      // expected
    }

    const url = new URL(getCapturedUrl());
    assert.equal(url.searchParams.get('categories'), 'news', 'Expected categories=news in URL');

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('categories="it,science" adds categories param to URL', async () => {
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');

    const mockServer = createMockServer();
    const { mockFetch, getCapturedUrl } = createCapturingMockFetch();

    fetchMocker.mock(async (url, options) => {
      await mockFetch(url, options);
      throw new Error('MOCK_STOP');
    });

    try {
      await performWebSearch(mockServer as any, 'test query', 1, undefined, undefined, undefined, undefined, undefined, 'it,science');
    } catch {
      // expected
    }

    const url = new URL(getCapturedUrl());
    assert.equal(url.searchParams.get('categories'), 'it,science', 'Expected categories=it,science in URL');

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('Omitting categories sends no categories param to SearXNG', async () => {
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');

    const mockServer = createMockServer();
    const { mockFetch, getCapturedUrl } = createCapturingMockFetch();

    fetchMocker.mock(async (url, options) => {
      await mockFetch(url, options);
      throw new Error('MOCK_STOP');
    });

    try {
      await performWebSearch(mockServer as any, 'test query');
    } catch {
      // expected
    }

    const url = new URL(getCapturedUrl());
    assert.equal(url.searchParams.get('categories'), null, 'No categories param should be sent when omitted');

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('engines="google,ddg" validates with /config and adds encoded engines param', async () => {
    clearInstanceInfoCacheForTests();
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');

    const mockServer = createMockServer();
    const requestedUrls: string[] = [];

    fetchMocker.mock(async (url) => {
      requestedUrls.push(url.toString());
      const parsedUrl = new URL(url.toString());
      if (parsedUrl.pathname.endsWith('/config')) {
        return createMockFetch({ json: makeConfigWithEngines() })(url);
      }
      return createMockFetch({ json: { results: [] } })(url);
    });

    await performWebSearch(mockServer as any, 'test query', 1, undefined, undefined, undefined, undefined, undefined, undefined, 'google,ddg');

    assert.equal(requestedUrls.length, 2, 'Expected /config validation before search');
    const searchUrl = requestedUrls[1];
    assert.equal(new URL(searchUrl).searchParams.get('engines'), 'google,ddg');

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('mixed-case engines and categories normalize to canonical /config names', async () => {
    clearInstanceInfoCacheForTests();
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');

    const mockServer = createMockServer();
    const requestedUrls: string[] = [];

    fetchMocker.mock(async (url) => {
      requestedUrls.push(url.toString());
      const parsedUrl = new URL(url.toString());
      if (parsedUrl.pathname.endsWith('/config')) {
        return createMockFetch({ json: makeConfigWithEngines() })(url);
      }
      return createMockFetch({ json: { results: [] } })(url);
    });

    await performWebSearch(
      mockServer as any,
      'test query',
      1,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      ' News , SOCIAL MEDIA ',
      ' Google , Semantic Scholar ',
    );

    const searchUrl = new URL(requestedUrls[1]);
    assert.equal(searchUrl.searchParams.get('categories'), 'news,social media');
    assert.equal(searchUrl.searchParams.get('engines'), 'google,semantic scholar');

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('unknown engine names from live /config pass through in caller order', async () => {
    clearInstanceInfoCacheForTests();
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');

    const mockServer = createMockServer();
    const requestedUrls: string[] = [];

    fetchMocker.mock(async (url) => {
      requestedUrls.push(url.toString());
      const parsedUrl = new URL(url.toString());
      if (parsedUrl.pathname.endsWith('/config')) {
        return createMockFetch({ json: makeConfigWithEngines() })(url);
      }
      return createMockFetch({ json: { results: [] } })(url);
    });

    await performWebSearch(mockServer as any, 'test query', 1, undefined, undefined, undefined, undefined, undefined, undefined, 'Google, missing , Semantic Scholar, bad');

    assert.equal(requestedUrls.length, 2, 'Expected /config validation before search');
    const searchUrl = new URL(requestedUrls[1]);
    assert.equal(searchUrl.searchParams.get('engines'), 'google,missing,semantic scholar,bad');

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('unknown category from live /config passes through in caller order', async () => {
    clearInstanceInfoCacheForTests();
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');

    const mockServer = createMockServer();
    const requestedUrls: string[] = [];

    fetchMocker.mock(async (url) => {
      requestedUrls.push(url.toString());
      const parsedUrl = new URL(url.toString());
      if (parsedUrl.pathname.endsWith('/config')) {
        return createMockFetch({ json: makeConfigWithEngines() })(url);
      }
      return createMockFetch({ json: { results: [] } })(url);
    });

    await performWebSearch(mockServer as any, 'test query', 1, undefined, undefined, undefined, undefined, undefined, 'News, unknown , Social Media');

    assert.equal(requestedUrls.length, 2, 'Expected /config validation before search');
    const searchUrl = new URL(requestedUrls[1]);
    assert.equal(searchUrl.searchParams.get('categories'), 'news,unknown,social media');

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('available-only engine from aggregate /config is accepted and normalized', async () => {
    clearInstanceInfoCacheForTests();
    envManager.set('SEARXNG_URL', 'https://one.example.com;https://two.example.com');

    const mockServer = createMockServer();
    const requestedUrls: string[] = [];

    fetchMocker.mock(async (url) => {
      requestedUrls.push(url.toString());
      const parsedUrl = new URL(url.toString());
      if (parsedUrl.pathname.endsWith('/config')) {
        const config = makeConfigWithEngines();
        if (parsedUrl.origin === 'https://two.example.com') {
          config.engines.push({ name: 'qwant', disabled: false });
        }
        return createMockFetch({ json: config })(url);
      }
      return createMockFetch({ json: { results: [] } })(url);
    });

    await performWebSearch(mockServer as any, 'test query', 1, undefined, undefined, undefined, undefined, undefined, undefined, 'Qwant', 'json');

    const searchUrl = new URL(requestedUrls.find((requestedUrl) => new URL(requestedUrl).pathname.endsWith('/search'))!);
    assert.equal(searchUrl.searchParams.get('engines'), 'qwant');

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('unknown value with cached config is forwarded without refresh retry', async () => {
    clearInstanceInfoCacheForTests();
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');

    const mockServer = createMockServer();
    const requestedUrls: string[] = [];
    let configFetchCount = 0;

    fetchMocker.mock(async (url) => {
      requestedUrls.push(url.toString());
      const parsedUrl = new URL(url.toString());
      if (parsedUrl.pathname.endsWith('/config')) {
        configFetchCount++;
        const config = makeConfigWithEngines();
        return createMockFetch({ json: config })(url);
      }
      return createMockFetch({ json: { results: [] } })(url);
    });

    await performWebSearch(
      mockServer as any,
      'test query',
      1,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'Software Wikis',
      'Annas Archive',
    );

    assert.equal(configFetchCount, 1, 'Expected cached config without invalid-value refresh retry');
    const configRequests = requestedUrls.filter((url) => new URL(url).pathname.endsWith('/config'));
    assert.equal(configRequests.length, 1, 'Expected exactly one config request');
    const searchUrl = new URL(requestedUrls[1]);
    assert.equal(searchUrl.searchParams.get('categories'), 'Software Wikis');
    assert.equal(searchUrl.searchParams.get('engines'), 'Annas Archive');

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('unavailable /config forwards engines and categories and prepends text warning', async () => {
    clearInstanceInfoCacheForTests();
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');

    const mockServer = createMockServer();
    const requestedUrls: string[] = [];

    fetchMocker.mock(async (url) => {
      requestedUrls.push(url.toString());
      const parsedUrl = new URL(url.toString());
      if (parsedUrl.pathname.endsWith('/config')) {
        return createMockFetch({ ok: false, status: 403, statusText: 'Forbidden' })(url);
      }
      return createMockFetch({
        json: {
          results: [
            {
              title: 'Forwarded Result',
              content: 'Search still ran',
              url: 'https://example.com/forwarded',
              score: 0.9,
            },
          ],
        },
      })(url);
    });

    const result = await performWebSearch(mockServer as any, 'test query', 1, undefined, undefined, undefined, undefined, undefined, 'Unknown Category', 'Unknown Engine');

    assert.ok(result.startsWith('Note: categories and engines were not validated or normalized'), result);
    assert.ok(result.includes('Forwarded Result'), result);
    const searchUrl = requestedUrls[1];
    assert.equal(new URL(searchUrl).searchParams.get('categories'), 'Unknown Category');
    assert.equal(new URL(searchUrl).searchParams.get('engines'), 'Unknown Engine');

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('unavailable /config includes warnings in JSON response when categories and engines are provided', async () => {
    clearInstanceInfoCacheForTests();
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');

    const mockServer = createMockServer();

    fetchMocker.mock(async (url) => {
      const parsedUrl = new URL(url.toString());
      if (parsedUrl.pathname.endsWith('/config')) {
        throw new Error('config blocked');
      }
      return createMockFetch({ json: { query: 'test query', results: [] } })(url);
    });

    const result = await performWebSearch(mockServer as any, 'test query', 1, undefined, undefined, undefined, undefined, undefined, 'Unknown Category', 'Unknown Engine', 'json');
    const payload = JSON.parse(result);

    assert.deepEqual(payload.warnings, ['Categories and engines were not validated or normalized because SearXNG /config is unavailable.']);

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('unavailable /config prepends categories-only text warning', async () => {
    clearInstanceInfoCacheForTests();
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');

    const mockServer = createMockServer();

    fetchMocker.mock(async (url) => {
      const parsedUrl = new URL(url.toString());
      if (parsedUrl.pathname.endsWith('/config')) {
        return createMockFetch({ ok: false, status: 403, statusText: 'Forbidden' })(url);
      }
      return createMockFetch({ json: { results: makeMockSearchResults(1) } })(url);
    });

    const result = await performWebSearch(mockServer as any, 'test query', 1, undefined, undefined, undefined, undefined, undefined, 'Unknown Category');

    assert.ok(result.startsWith('Note: categories were not validated or normalized (SearXNG /config unavailable).'), result);
    assert.ok(!result.includes('categories and engines were not validated'), result);
    assert.ok(!result.includes('engines were not validated'), result);

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('unavailable /config includes engines-only JSON warning', async () => {
    clearInstanceInfoCacheForTests();
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');

    const mockServer = createMockServer();

    fetchMocker.mock(async (url) => {
      const parsedUrl = new URL(url.toString());
      if (parsedUrl.pathname.endsWith('/config')) {
        throw new Error('config blocked');
      }
      return createMockFetch({ json: { query: 'test query', results: [] } })(url);
    });

    const result = await performWebSearch(mockServer as any, 'test query', 1, undefined, undefined, undefined, undefined, undefined, undefined, 'Unknown Engine', 'json');
    const payload = JSON.parse(result);

    assert.deepEqual(payload.warnings, ['Engines were not validated or normalized because SearXNG /config is unavailable.']);

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('omitting engines skips /config validation and sends no engines param', async () => {
    clearInstanceInfoCacheForTests();
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');

    const mockServer = createMockServer();
    const requestedUrls: string[] = [];

    fetchMocker.mock(async (url) => {
      requestedUrls.push(url.toString());
      return createMockFetch({ json: { results: [] } })(url);
    });

    await performWebSearch(mockServer as any, 'test query');

    assert.equal(requestedUrls.length, 1, 'Expected only the search request when engines is omitted');
    const searchUrl = new URL(requestedUrls[0]);
    assert.ok(searchUrl.pathname.endsWith('/search'));
    assert.equal(searchUrl.searchParams.get('engines'), null);

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('blank engines string skips /config validation and sends no engines param', async () => {
    clearInstanceInfoCacheForTests();
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');

    const mockServer = createMockServer();
    const requestedUrls: string[] = [];

    fetchMocker.mock(async (url) => {
      requestedUrls.push(url.toString());
      return createMockFetch({ json: { results: [] } })(url);
    });

    await performWebSearch(mockServer as any, 'test query', 1, undefined, undefined, undefined, undefined, undefined, undefined, '   ');

    assert.equal(requestedUrls.length, 1, 'Expected only the search request when engines is blank');
    assert.equal(new URL(requestedUrls[0]).searchParams.get('engines'), null);

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('SEARXNG_DEFAULT_LANGUAGE sets language when per-call language is omitted', async () => {
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');
    envManager.set('SEARXNG_DEFAULT_LANGUAGE', 'fr');

    const mockServer = createMockServer();
    const { mockFetch, getCapturedUrl } = createCapturingMockFetch();

    fetchMocker.mock(async (url, options) => {
      await mockFetch(url, options);
      throw new Error('MOCK_STOP');
    });

    try {
      await performWebSearch(mockServer as any, 'test query');
    } catch {
      // expected
    }

    const url = new URL(getCapturedUrl());
    assert.equal(url.searchParams.get('language'), 'fr', 'Expected language=fr from SEARXNG_DEFAULT_LANGUAGE');

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('Per-call language overrides SEARXNG_DEFAULT_LANGUAGE', async () => {
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');
    envManager.set('SEARXNG_DEFAULT_LANGUAGE', 'fr');

    const mockServer = createMockServer();
    const { mockFetch, getCapturedUrl } = createCapturingMockFetch();

    fetchMocker.mock(async (url, options) => {
      await mockFetch(url, options);
      throw new Error('MOCK_STOP');
    });

    try {
      await performWebSearch(mockServer as any, 'test query', 1, undefined, 'de');
    } catch {
      // expected
    }

    const url = new URL(getCapturedUrl());
    assert.equal(url.searchParams.get('language'), 'de', 'Per-call language should override env default');

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('SEARXNG_DEFAULT_SAFESEARCH sets safesearch when per-call safesearch is omitted', async () => {
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');
    envManager.set('SEARXNG_DEFAULT_SAFESEARCH', '2');

    const mockServer = createMockServer();
    const { mockFetch, getCapturedUrl } = createCapturingMockFetch();

    fetchMocker.mock(async (url, options) => {
      await mockFetch(url, options);
      throw new Error('MOCK_STOP');
    });

    try {
      await performWebSearch(mockServer as any, 'test query');
    } catch {
      // expected
    }

    const url = new URL(getCapturedUrl());
    assert.equal(url.searchParams.get('safesearch'), '2', 'Expected safesearch=2 from SEARXNG_DEFAULT_SAFESEARCH');

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('Per-call safesearch=0 overrides SEARXNG_DEFAULT_SAFESEARCH=2', async () => {
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');
    envManager.set('SEARXNG_DEFAULT_SAFESEARCH', '2');

    const mockServer = createMockServer();
    const { mockFetch, getCapturedUrl } = createCapturingMockFetch();

    fetchMocker.mock(async (url, options) => {
      await mockFetch(url, options);
      throw new Error('MOCK_STOP');
    });

    try {
      await performWebSearch(mockServer as any, 'test query', 1, undefined, undefined, 0);
    } catch {
      // expected
    }

    const url = new URL(getCapturedUrl());
    assert.equal(url.searchParams.get('safesearch'), '0', 'Per-call safesearch=0 should override env default=2');

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('Invalid SEARXNG_DEFAULT_SAFESEARCH is silently ignored', async () => {
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');
    envManager.set('SEARXNG_DEFAULT_SAFESEARCH', 'bad-value');

    const mockServer = createMockServer();
    const { mockFetch, getCapturedUrl } = createCapturingMockFetch();

    fetchMocker.mock(async (url, options) => {
      await mockFetch(url, options);
      throw new Error('MOCK_STOP');
    });

    try {
      await performWebSearch(mockServer as any, 'test query');
    } catch {
      // expected
    }

    const url = new URL(getCapturedUrl());
    assert.equal(url.searchParams.get('safesearch'), null, 'Invalid SEARXNG_DEFAULT_SAFESEARCH should not set URL param');

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('text output prepends answers before result list', async () => {
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');

    const mockServer = createMockServer();
    fetchMocker.mock(createMockFetch({
      json: {
        answers: ['42'],
        results: [
          {
            title: 'Answer Result',
            content: 'Result content',
            url: 'https://example.com/answer',
            score: 1,
          },
        ],
      },
    }));

    const result = await performWebSearch(mockServer as any, 'answer query');
    assert.ok(result.startsWith('Direct answer: 42\n\n---\n\nTitle: Answer Result'), result);

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('text output prepends corrections and suggestions only when present', async () => {
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');

    const mockServer = createMockServer();
    fetchMocker.mock(createMockFetch({
      json: {
        corrections: ['typescript'],
        suggestions: ['typescript tutorial', 'typescript handbook'],
        results: [
          {
            title: 'TS Result',
            content: 'Typed JS',
            url: 'https://example.com/ts',
            score: 0.9,
          },
        ],
      },
    }));

    const result = await performWebSearch(mockServer as any, 'typscript');
    assert.ok(result.includes('Spelling correction: did you mean "typescript"?'), result);
    assert.ok(result.includes('Suggestions: typescript tutorial, typescript handbook'), result);
    assert.ok(!result.includes('Direct answer:'), result);

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('text output prepends infoboxes but omits unresponsive engines', async () => {
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');

    const mockServer = createMockServer();
    fetchMocker.mock(createMockFetch({
      json: {
        infoboxes: [
          {
            infobox: 'Ada Lovelace',
            content: 'English mathematician and writer',
            urls: [{ title: 'Biography', url: 'https://example.com/ada' }],
          },
        ],
        unresponsive_engines: [['brave', 'timeout']],
        results: [
          {
            title: 'Ada Result',
            content: 'Computing pioneer',
            url: 'https://example.com/result',
            score: 0.8,
          },
        ],
      },
    }));

    const result = await performWebSearch(mockServer as any, 'Ada Lovelace');
    assert.ok(result.includes('Infobox: Ada Lovelace'), result);
    assert.ok(result.includes('English mathematician and writer'), result);
    assert.ok(result.split('\n').some((line) => line === 'Biography: https://example.com/ada'), result);
    assert.ok(!result.includes('Unresponsive engines:'), result);

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('text output preserves metadata when filters remove all results', async () => {
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');

    const mockServer = createMockServer();
    fetchMocker.mock(createMockFetch({
      json: {
        query: 'capital of France',
        answers: ['The capital of France is Paris'],
        results: [
          {
            title: 'Low Score Result',
            content: 'Paris information',
            url: 'https://example.com/paris',
            score: 0.3,
          },
        ],
      },
    }));

    const result = await performWebSearch(mockServer as any, 'capital of France', 1, undefined, undefined, undefined, 0.9);
    assert.ok(result.startsWith('Direct answer: The capital of France is Paris\n\n---\n\n'), result);
    assert.ok(result.includes('No results found for "capital of France"'), result);
    assert.ok(!result.includes('Title: Low Score Result'), result);

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('text output is unchanged when optional metadata is absent', async () => {
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');

    const mockServer = createMockServer();
    fetchMocker.mock(createMockFetch({
      json: {
        results: [
          {
            title: 'Plain Result',
            content: 'Plain content',
            url: 'https://example.com/plain',
            score: 0.75,
          },
        ],
      },
    }));

    const result = await performWebSearch(mockServer as any, 'plain query');
    assert.equal(
      result,
      'Title: Plain Result\nDescription: Plain content\nURL: https://example.com/plain\nRelevance Score: 0.750',
    );

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('response_format=json returns parseable SearXNG JSON with raw metadata', async () => {
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');

    const mockServer = createMockServer();
    fetchMocker.mock(createMockFetch({
      json: {
        query: 'answer query',
        number_of_results: 1,
        answers: ['42'],
        results: [
          {
            title: 'Answer Result',
            content: 'Result content',
            url: 'https://example.com/answer',
            score: 1,
            engines: ['google'],
          },
        ],
      },
    }));

    const result = await performWebSearch(mockServer as any, 'answer query', 1, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 'json');
    const payload = JSON.parse(result);
    assert.equal(payload.query, 'answer query');
    assert.deepEqual(payload.answers, ['42']);
    assert.equal(payload.results[0].engines[0], 'google');
    assert.ok(!result.includes('Direct answer:'), result);

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('response_format=text returns formatted text output', async () => {
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');

    const mockServer = createMockServer();
    fetchMocker.mock(createMockFetch({
      json: {
        results: [
          {
            title: 'Text Result',
            content: 'Text content',
            url: 'https://example.com/text',
            score: 0.9,
          },
        ],
      },
    }));

    const result = await performWebSearch(mockServer as any, 'text query', 1, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 'text');
    assert.ok(result.includes('Title: Text Result'));
    assert.throws(() => JSON.parse(result));

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('response_format=json applies result slicing', async () => {
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');

    const mockServer = createMockServer();
    fetchMocker.mock(createMockFetch({
      json: {
        query: 'slice query',
        number_of_results: 3,
        results: makeMockSearchResults(3),
      },
    }));

    const result = await performWebSearch(mockServer as any, 'slice query', 1, undefined, undefined, undefined, undefined, 2, undefined, undefined, 'json');
    const payload = JSON.parse(result);
    assert.equal(payload.results.length, 2);
    assert.equal(payload.results[0].title, 'Result 1');
    assert.equal(payload.results[1].title, 'Result 2');

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('response_format=json returns JSON with empty results instead of prose no-results diagnostic', async () => {
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');

    const mockServer = createMockServer();
    fetchMocker.mock(createMockFetch({
      json: {
        query: 'empty query',
        number_of_results: 0,
        suggestions: ['broader query'],
        results: [],
      },
    }));

    const result = await performWebSearch(mockServer as any, 'empty query', 1, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 'json');
    const payload = JSON.parse(result);
    assert.equal(payload.query, 'empty query');
    assert.deepEqual(payload.results, []);
    assert.deepEqual(payload.suggestions, ['broader query']);
    assert.ok(!result.includes('No results found'), result);

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('single-instance JSON response has no servedBy provenance', async () => {
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');
    envManager.delete('SEARXNG_FANOUT');

    const mockServer = createMockServer();
    fetchMocker.mock(createMockFetch({
      json: {
        query: 'single query',
        results: [
          { title: 'Single Result', content: 'Only instance', url: 'https://example.com/single', score: 1 },
        ],
      },
    }));

    const result = await performWebSearch(mockServer as any, 'single query', 1, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 'json');
    const payload = JSON.parse(result);
    assert.equal(payload.servedBy, undefined);

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('multi-instance failover tries second after first hard failure and reports servedBy', async () => {
    clearSearxngInstanceStateForTests();
    envManager.set('SEARXNG_URL', 'https://first.example.com;https://second.example.com');
    envManager.delete('SEARXNG_FANOUT');

    const mockServer = createMockServer();
    const requestedHosts: string[] = [];
    fetchMocker.mock(async (url) => {
      const parsedUrl = new URL(url.toString());
      requestedHosts.push(parsedUrl.origin);
      if (parsedUrl.hostname === 'first.example.com') {
        throw new Error('first down');
      }
      return createMockFetch({
        json: {
          query: 'failover query',
          results: [
            { title: 'Second Result', content: 'Recovered', url: 'https://example.com/recovered', score: 0.9 },
          ],
        },
      })(url);
    });

    const result = await performWebSearch(mockServer as any, 'failover query', 1, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 'json');
    const payload = JSON.parse(result);

    assert.deepEqual(requestedHosts, ['https://first.example.com', 'https://second.example.com']);
    assert.deepEqual(payload.servedBy, ['https://second.example.com']);
    assert.equal(payload.results[0].title, 'Second Result');

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('multi-instance search uses embedded auth first and global fallback second', async () => {
    clearSearxngInstanceStateForTests();
    envManager.set('SEARXNG_URL', 'https://embedded:p%40ss@first.example.com;https://second.example.com');
    envManager.set('AUTH_USERNAME', 'global-user');
    envManager.set('AUTH_PASSWORD', 'global-pass');
    envManager.delete('SEARXNG_FANOUT');

    const mockServer = createMockServer();
    const requests: Array<{ url: string; authorization?: string }> = [];

    fetchMocker.mock(async (url, options) => {
      const headers = (options?.headers || {}) as Record<string, string>;
      requests.push({
        url: url.toString(),
        authorization: headers['authorization'],
      });

      const parsedUrl = new URL(url.toString());
      if (parsedUrl.hostname === 'first.example.com') {
        throw new Error('first instance unavailable');
      }

      return createMockFetch({
        json: {
          query: 'multi auth',
          results: [
            { title: 'Second Result', content: 'Second', url: 'https://example.com/second', score: 1 },
          ],
        },
      })(url, options);
    });

    const result = await performWebSearch(mockServer as any, 'multi auth', 1, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 'json');
    const payload = JSON.parse(result);

    assert.equal(payload.results[0].title, 'Second Result');
    assert.equal(requests.length, 2);
    assert.equal(requests[0].authorization, `Basic ${Buffer.from('embedded:p@ss').toString('base64')}`);
    assert.equal(requests[1].authorization, `Basic ${Buffer.from('global-user:global-pass').toString('base64')}`);
    assert.ok(!requests[0].url.includes('embedded:p%40ss@'), requests[0].url);
    assert.equal(new URL(requests[0].url).username, '');
    assert.equal(new URL(requests[1].url).username, '');

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('multi-instance servedBy provenance redacts configured URL credentials in JSON output', async () => {
    clearSearxngInstanceStateForTests();
    envManager.set('SEARXNG_URL', 'https://user:pass@first.example.com;https://user:pass@second.example.com');
    envManager.delete('SEARXNG_FANOUT');

    const mockServer = createMockServer();
    fetchMocker.mock(async (url) => {
      const parsedUrl = new URL(url.toString());
      if (parsedUrl.hostname === 'first.example.com') {
        throw new Error('first down');
      }
      return createMockFetch({
        json: {
          query: 'redacted servedBy',
          results: [
            { title: 'Second Result', content: 'Recovered', url: 'https://example.com/recovered', score: 0.9 },
          ],
        },
      })(url);
    });

    const result = await performWebSearch(mockServer as any, 'redacted servedBy', 1, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 'json');
    const payload = JSON.parse(result);

    assert.deepEqual(payload.servedBy, ['https://second.example.com/']);
    assert.ok(!result.includes('user:pass@'), result);
    assert.ok(!result.includes('user'), result);
    assert.ok(!result.includes('pass'), result);

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('multi-instance servedBy provenance redacts configured URL credentials in text output', async () => {
    clearSearxngInstanceStateForTests();
    envManager.set('SEARXNG_URL', 'https://user:pass@empty-one.example.com;https://user:pass@empty-two.example.com');

    const mockServer = createMockServer();
    fetchMocker.mock(createMockFetch({ json: { query: 'empty text', results: [] } }));

    const result = await performWebSearch(mockServer as any, 'empty text');

    assert.equal(
      result.split('\n')[0],
      'Served by SearXNG instances: https://empty-one.example.com/, https://empty-two.example.com/',
    );
    assert.ok(!result.includes('user:pass@'), result);
    assert.ok(!result.includes('user'), result);
    assert.ok(!result.includes('pass'), result);

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('empty multi-instance response is healthy and fails over without cooldown', async () => {
    clearSearxngInstanceStateForTests();
    envManager.set('SEARXNG_URL', 'https://empty.example.com;https://second.example.com');

    const mockServer = createMockServer();
    const requestedHosts: string[] = [];
    fetchMocker.mock(async (url) => {
      const parsedUrl = new URL(url.toString());
      requestedHosts.push(parsedUrl.origin);
      if (parsedUrl.hostname === 'empty.example.com') {
        return createMockFetch({ json: { query: 'empty first', results: [] } })(url);
      }
      return createMockFetch({
        json: {
          query: 'empty first',
          results: [
            { title: 'Second Result', content: 'Has result', url: 'https://example.com/second', score: 0.8 },
          ],
        },
      })(url);
    });

    const firstResult = await performWebSearch(mockServer as any, 'empty first', 1, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 'json');
    const secondResult = await performWebSearch(mockServer as any, 'empty first again', 1, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 'json');

    assert.deepEqual(requestedHosts, [
      'https://empty.example.com',
      'https://second.example.com',
      'https://empty.example.com',
      'https://second.example.com',
    ]);
    assert.deepEqual(JSON.parse(firstResult).servedBy, ['https://second.example.com']);
    assert.deepEqual(JSON.parse(secondResult).servedBy, ['https://second.example.com']);

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('all multi-instance responses empty returns existing JSON empty response with provenance', async () => {
    clearSearxngInstanceStateForTests();
    envManager.set('SEARXNG_URL', 'https://empty-one.example.com;https://empty-two.example.com');

    const mockServer = createMockServer();
    fetchMocker.mock(createMockFetch({ json: { query: 'empty query', number_of_results: 0, results: [] } }));

    const result = await performWebSearch(mockServer as any, 'empty query', 1, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 'json');
    const payload = JSON.parse(result);

    assert.deepEqual(payload.results, []);
    assert.deepEqual(payload.servedBy, ['https://empty-one.example.com', 'https://empty-two.example.com']);
    assert.ok(!result.includes('No results found'));

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('all multi-instance responses empty returns existing text no-results message with provenance', async () => {
    clearSearxngInstanceStateForTests();
    envManager.set('SEARXNG_URL', 'https://empty-one.example.com;https://empty-two.example.com');

    const mockServer = createMockServer();
    fetchMocker.mock(createMockFetch({ json: { query: 'empty text', results: [] } }));

    const result = await performWebSearch(mockServer as any, 'empty text');

    assert.equal(
      result.split('\n')[0],
      'Served by SearXNG instances: https://empty-one.example.com, https://empty-two.example.com',
    );
    assert.ok(result.includes('No results found for "empty text"'), result);

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('all multi-instance hard failures throw aggregate error with underlying reason', async () => {
    clearSearxngInstanceStateForTests();
    envManager.set('SEARXNG_URL', 'https://first.example.com;https://second.example.com');

    const mockServer = createMockServer();
    fetchMocker.mock(async (url) => {
      const parsedUrl = new URL(url.toString());
      throw new Error(`${parsedUrl.hostname} failed`);
    });

    try {
      await performWebSearch(mockServer as any, 'all fail');
      assert.fail('Expected aggregate multi-instance failure');
    } catch (error: any) {
      assert.ok(error.message.includes('All configured SearXNG instances failed'), error.message);
      assert.match(error.message, /first\.example\.com failed/);
      assert.match(error.message, /second\.example\.com failed/);
    }

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('all multi-instance hard failures redact credential-bearing configured URLs in aggregate error', async () => {
    clearSearxngInstanceStateForTests();
    envManager.set('SEARXNG_URL', 'https://user:pass@first.example.com;https://user:pass@second.example.com');

    const mockServer = createMockServer();
    fetchMocker.mock(async (url) => {
      throw new Error(`${url.toString()} failed`);
    });

    try {
      await performWebSearch(mockServer as any, 'all fail redacted');
      assert.fail('Expected aggregate multi-instance failure');
    } catch (error: any) {
      assert.ok(error.message.includes('All configured SearXNG instances failed'), error.message);
      assert.match(error.message, /^All configured SearXNG instances failed\. https:\/\/first\.example\.com\/: /);
      assert.match(error.message, /^All configured SearXNG instances failed\..*https:\/\/second\.example\.com\/: /);
      assert.ok(!error.message.includes('user:pass@'), error.message);
      assert.ok(!error.message.includes('user'), error.message);
      assert.ok(!error.message.includes('pass'), error.message);
    }

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('credential-free aggregate hard-failure text is unchanged exactly', async () => {
    clearSearxngInstanceStateForTests();
    envManager.set('SEARXNG_URL', 'https://first.example.com;https://second.example.com');

    const mockServer = createMockServer();
    fetchMocker.mock(async (url) => {
      const parsedUrl = new URL(url.toString());
      throw new Error(`${parsedUrl.hostname} failed`);
    });

    try {
      await performWebSearch(mockServer as any, 'all fail exact');
      assert.fail('Expected aggregate multi-instance failure');
    } catch (error: any) {
      assert.equal(
        error.message,
        'All configured SearXNG instances failed. https://first.example.com: 🌐 Network Error: first.example.com failed; https://second.example.com: 🌐 Network Error: second.example.com failed',
      );
    }

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('single-instance ECONNREFUSED error redacts credential-bearing configured URL', async () => {
    clearSearxngInstanceStateForTests();
    envManager.set('SEARXNG_URL', 'https://user:pass@only.example.com');

    const mockServer = createMockServer();
    const refused = new Error('connect ECONNREFUSED');
    (refused as any).code = 'ECONNREFUSED';
    fetchMocker.mock(async () => {
      throw refused;
    });

    try {
      await performWebSearch(mockServer as any, 'refused');
      assert.fail('Expected ECONNREFUSED error');
    } catch (error: any) {
      assert.match(error.message, /^🌐 Connection Error: SearXNG server is not responding \(https:\/\/only\.example\.com\//);
      assert.ok(!error.message.includes('user:pass@'), error.message);
      assert.ok(!error.message.includes('user'), error.message);
      assert.ok(!error.message.includes('pass'), error.message);
    }

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('search request log redacts credential-bearing configured URL', async () => {
    clearSearxngInstanceStateForTests();
    envManager.set('SEARXNG_URL', 'https://user:pass@log.example.com');

    const { server, getLoggingCalls } = createMockServerWithTracking();
    fetchMocker.mock(createMockFetch({
      json: {
        query: 'log redaction',
        results: [
          { title: 'Logged Result', content: 'Logged', url: 'https://example.com/logged', score: 1 },
        ],
      },
    }));

    await performWebSearch(server as any, 'log redaction');

    const requestLog = getLoggingCalls()
      .map((call) => call.data?.message)
      .find((message) => typeof message === 'string' && message.includes('Making request to:'));
    assert.ok(requestLog, 'Expected Making request to log');
    assert.match(requestLog, /^Making request to: https:\/\/log\.example\.com\//);
    assert.ok(!requestLog.includes('user:pass@'), requestLog);
    assert.ok(!requestLog.includes('user'), requestLog);
    assert.ok(!requestLog.includes('pass'), requestLog);

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('cooled down instance is skipped during failover', async () => {
    clearSearxngInstanceStateForTests();
    envManager.set('SEARXNG_URL', 'https://cooled.example.com;https://healthy.example.com');

    recordSearxngInstanceFailure('https://cooled.example.com', Date.now());
    recordSearxngInstanceFailure('https://cooled.example.com', Date.now());
    recordSearxngInstanceFailure('https://cooled.example.com', Date.now());

    const mockServer = createMockServer();
    const requestedHosts: string[] = [];
    fetchMocker.mock(async (url) => {
      const parsedUrl = new URL(url.toString());
      requestedHosts.push(parsedUrl.origin);
      return createMockFetch({
        json: {
          query: 'skip cooled',
          results: [
            { title: 'Healthy Result', content: 'Healthy', url: 'https://example.com/healthy', score: 1 },
          ],
        },
      })(url);
    });

    const result = await performWebSearch(mockServer as any, 'skip cooled');

    assert.deepEqual(requestedHosts, ['https://healthy.example.com']);
    assert.ok(result.includes('Healthy Result'));

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('fanout dedupes canonical URLs, keeps highest score, and orders descending', async () => {
    clearSearxngInstanceStateForTests();
    envManager.set('SEARXNG_URL', 'https://one.example.com;https://two.example.com');
    envManager.set('SEARXNG_FANOUT', 'true');

    const mockServer = createMockServer();
    const requestedHosts: string[] = [];
    fetchMocker.mock(async (url) => {
      const parsedUrl = new URL(url.toString());
      requestedHosts.push(parsedUrl.origin);
      if (parsedUrl.hostname === 'one.example.com') {
        return createMockFetch({
          json: {
            query: 'fanout',
            number_of_results: 2,
            results: [
              { title: 'Lower Duplicate', content: 'Low', url: 'https://Example.com/same#section', score: 0.2 },
              { title: 'Missing Score', content: 'No score', url: 'not a url', score: undefined },
            ],
          },
        })(url);
      }
      return createMockFetch({
        json: {
          query: 'fanout',
          number_of_results: 3,
          results: [
            { title: 'Highest', content: 'High', url: 'https://example.com/high', score: 0.95 },
            { title: 'Higher Duplicate', content: 'Better', url: 'https://example.com/same', score: 0.7 },
            { title: 'Raw URL Copy', content: 'Raw tie', url: 'not a url', score: 0.5 },
          ],
        },
      })(url);
    });

    const result = await performWebSearch(mockServer as any, 'fanout', 1, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 'json');
    const payload = JSON.parse(result);

    assert.deepEqual(requestedHosts.sort(), ['https://one.example.com', 'https://two.example.com']);
    assert.deepEqual(payload.servedBy, ['https://one.example.com', 'https://two.example.com']);
    assert.deepEqual(payload.results.map((entry: any) => entry.title), ['Highest', 'Higher Duplicate', 'Raw URL Copy']);
    assert.equal(payload.number_of_results, payload.results.length);
    assert.equal(payload.number_of_results, 3);

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('all cooled down instances throw cooldown-specific message without double spaces', async () => {
    clearSearxngInstanceStateForTests();
    envManager.set('SEARXNG_URL', 'https://cooled-one.example.com;https://cooled-two.example.com');

    for (const instanceUrl of ['https://cooled-one.example.com', 'https://cooled-two.example.com']) {
      recordSearxngInstanceFailure(instanceUrl, Date.now());
      recordSearxngInstanceFailure(instanceUrl, Date.now());
      recordSearxngInstanceFailure(instanceUrl, Date.now());
    }

    const mockServer = createMockServer();
    let fetchCalled = false;
    fetchMocker.mock(async () => {
      fetchCalled = true;
      return createMockFetch({ json: { results: [] } })('https://unused.example.com');
    });

    try {
      await performWebSearch(mockServer as any, 'all cooled');
      assert.fail('Expected all-cooled error');
    } catch (error: any) {
      // Exact-match (not URL substring .includes()) so the assertion also covers
      // ordering and the absence of double spaces, and avoids CodeQL's
      // incomplete-url-substring-sanitization false positive on test code.
      assert.equal(
        error.message,
        'All configured SearXNG instances are in cooldown after repeated failures: https://cooled-one.example.com, https://cooled-two.example.com.',
      );
      assert.ok(!error.message.includes('  '), error.message);
    }
    assert.equal(fetchCalled, false);

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('all cooled down credential-bearing instances redact credentials and do not fetch', async () => {
    clearSearxngInstanceStateForTests();
    const configuredUrls = [
      'https://user:pass@cooled-one.example.com',
      'https://user:pass@cooled-two.example.com',
    ];
    envManager.set('SEARXNG_URL', configuredUrls.join(';'));

    for (const instanceUrl of configuredUrls) {
      recordSearxngInstanceFailure(instanceUrl, Date.now());
      recordSearxngInstanceFailure(instanceUrl, Date.now());
      recordSearxngInstanceFailure(instanceUrl, Date.now());
    }

    const mockServer = createMockServer();
    let fetchCalled = false;
    fetchMocker.mock(async () => {
      fetchCalled = true;
      return createMockFetch({ json: { results: [] } })('https://unused.example.com');
    });

    try {
      await performWebSearch(mockServer as any, 'all cooled redacted');
      assert.fail('Expected all-cooled error');
    } catch (error: any) {
      assert.equal(error.message, 'All configured SearXNG instances are in cooldown after repeated failures: https://cooled-one.example.com/, https://cooled-two.example.com/.');
      assert.ok(!error.message.includes('user:pass@'), error.message);
      assert.ok(!error.message.includes('user'), error.message);
      assert.ok(!error.message.includes('pass'), error.message);
    }
    assert.equal(fetchCalled, false);

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('fanout returns partial successes and excludes failed instances from servedBy', async () => {
    clearSearxngInstanceStateForTests();
    envManager.set('SEARXNG_URL', 'https://down.example.com;https://up.example.com');
    envManager.set('SEARXNG_FANOUT', 'true');

    const mockServer = createMockServer();
    fetchMocker.mock(async (url) => {
      const parsedUrl = new URL(url.toString());
      if (parsedUrl.hostname === 'down.example.com') {
        throw new Error('fanout down');
      }
      return createMockFetch({
        json: {
          query: 'partial fanout',
          results: [
            { title: 'Up Result', content: 'Up', url: 'https://example.com/up', score: 0.6 },
          ],
        },
      })(url);
    });

    const result = await performWebSearch(mockServer as any, 'partial fanout', 1, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 'json');
    const payload = JSON.parse(result);

    assert.deepEqual(payload.servedBy, ['https://up.example.com']);
    assert.equal(payload.results[0].title, 'Up Result');

    fetchMocker.restore();
    envManager.restore();
  }, results);

  printTestSummary(results, 'Search Module');
  return results;
}

// Run if executed directly
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  runTests().then(results => {
    process.exit(results.failed > 0 ? 1 : 0);
  }).catch(console.error);
}

export { runTests };
