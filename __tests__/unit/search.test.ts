#!/usr/bin/env tsx

/**
 * Unit Tests: search.ts
 * 
 * Tests for SearXNG search functionality
 */

import { strict as assert } from 'node:assert';
import { fileURLToPath } from 'node:url';
import { performWebSearch } from '../../src/search.js';
import { clearInstanceInfoCacheForTests } from '../../src/instance-info.js';
import { testFunction, createTestResults, printTestSummary } from '../helpers/test-utils.js';
import { createMockServer } from '../helpers/mock-server.js';
import { FetchMocker, createMockFetch, createCapturingMockFetch, createAbortableMockFetch } from '../helpers/mock-fetch.js';
import { EnvManager } from '../helpers/env-utils.js';

const results = createTestResults();
const fetchMocker = new FetchMocker();
const envManager = new EnvManager();

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
    assert.ok(url.pathname.includes('/search'));
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
    assert.ok(url.pathname.includes('/subpath/search'), `Expected path to contain /instance/search, got ${url.pathname}`);
    
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
    assert.ok(url.pathname.includes('/subpath/search'), `Expected path to contain /instance/search, got ${url.pathname}`);

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
    assert.ok(headers['Authorization']);
    assert.ok(headers['Authorization'].startsWith('Basic '));

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
    
    fetchMocker.mock(async () => ({
      ok: true,
      json: async () => {
        throw new Error('Invalid JSON');
      },
      text: async () => 'Invalid JSON response'
    } as any));

    try {
      await performWebSearch(mockServer as any, 'test query');
      assert.fail('Should have thrown JSON parsing error');
    } catch (error: any) {
      assert.ok(error.message.includes('JSON Error') || error.message.includes('Invalid JSON') || error.name === 'MCPSearXNGError');
    }

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
    assert.ok(typeof result === 'string');
    assert.ok(result.includes('Test Result 1'));
    assert.ok(result.includes('Test Result 2'));
    assert.ok(result.includes('URL: https://example.com/1'));
    assert.ok(result.includes('URL: https://example.com/2'));

    fetchMocker.restore();
    envManager.restore();
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
    assert.ok(result.includes('Title: Long title should stay intact'));
    assert.ok(result.includes('Description: abcdefghij…'));
    assert.ok(result.includes('URL: https://example.com/long-url-that-stays-intact'));
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

  await testFunction('User-Agent header added when USER_AGENT env var is set', async () => {
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');
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
    assert.ok(headers?.['User-Agent'] === 'MyCustomBot/1.0', `Expected User-Agent header, got: ${JSON.stringify(headers)}`);

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('User-Agent header absent when USER_AGENT env var not set', async () => {
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');
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
    assert.ok(!headers['User-Agent'], `Expected no User-Agent header`);

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
    assert.ok(searchUrl.includes('engines=google%2Cddg'), `Expected encoded engines param in ${searchUrl}`);
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

  await testFunction('invalid engine names from live /config throw helpful validation error', async () => {
    clearInstanceInfoCacheForTests();
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');

    const mockServer = createMockServer();
    let searchCalled = false;

    fetchMocker.mock(async (url) => {
      const parsedUrl = new URL(url.toString());
      if (parsedUrl.pathname.endsWith('/config')) {
        return createMockFetch({ json: makeConfigWithEngines() })(url);
      }
      searchCalled = true;
      return createMockFetch({ json: { results: [] } })(url);
    });

    try {
      await performWebSearch(mockServer as any, 'test query', 1, undefined, undefined, undefined, undefined, undefined, undefined, 'google,missing,bad');
      assert.fail('Expected invalid engine validation error');
    } catch (error: any) {
      assert.ok(error.message.includes('Invalid SearXNG engine name(s): missing, bad'), error.message);
      assert.ok(error.message.includes('searxng_instance_info'), error.message);
    }
    assert.equal(searchCalled, false, 'Search should not run after validation failure');

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('unknown category from live /config throws validation error with available categories', async () => {
    clearInstanceInfoCacheForTests();
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');

    const mockServer = createMockServer();
    let searchCalled = false;

    fetchMocker.mock(async (url) => {
      const parsedUrl = new URL(url.toString());
      if (parsedUrl.pathname.endsWith('/config')) {
        return createMockFetch({ json: makeConfigWithEngines() })(url);
      }
      searchCalled = true;
      return createMockFetch({ json: { results: [] } })(url);
    });

    try {
      await performWebSearch(mockServer as any, 'test query', 1, undefined, undefined, undefined, undefined, undefined, 'unknown');
      assert.fail('Expected invalid category validation error');
    } catch (error: any) {
      assert.ok(error.message.includes('Invalid SearXNG category name(s): unknown'), error.message);
      assert.ok(error.message.includes('Available categories: general, news, social media'), error.message);
      assert.ok(error.message.includes('searxng_instance_info'), error.message);
    }
    assert.equal(searchCalled, false, 'Search should not run after validation failure');

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('unknown engine from live /config throws validation error with available engines', async () => {
    clearInstanceInfoCacheForTests();
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');

    const mockServer = createMockServer();
    let searchCalled = false;

    fetchMocker.mock(async (url) => {
      const parsedUrl = new URL(url.toString());
      if (parsedUrl.pathname.endsWith('/config')) {
        return createMockFetch({ json: makeConfigWithEngines() })(url);
      }
      searchCalled = true;
      return createMockFetch({ json: { results: [] } })(url);
    });

    try {
      await performWebSearch(mockServer as any, 'test query', 1, undefined, undefined, undefined, undefined, undefined, undefined, 'missing');
      assert.fail('Expected invalid engine validation error');
    } catch (error: any) {
      assert.ok(error.message.includes('Invalid SearXNG engine name(s): missing'), error.message);
      assert.ok(error.message.includes('Available engines:'), error.message);
      assert.ok(error.message.includes('semantic scholar'), error.message);
    }
    assert.equal(searchCalled, false, 'Search should not run after validation failure');

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('stale config refreshes once and then normalizes newly available value', async () => {
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
        if (configFetchCount === 2) {
          config.categories.push('software wikis');
          config.engines.push({ name: 'annas archive', disabled: false });
        }
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

    assert.equal(configFetchCount, 2, 'Expected cached config plus one refresh');
    const configRequests = requestedUrls.filter((url) => new URL(url).pathname.endsWith('/config'));
    assert.equal(configRequests.length, 2, 'Expected exactly one refresh request');
    const searchUrl = new URL(requestedUrls[2]);
    assert.equal(searchUrl.searchParams.get('categories'), 'software wikis');
    assert.equal(searchUrl.searchParams.get('engines'), 'annas archive');

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
    assert.ok(result.includes('Biography: https://example.com/ada'), result);
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
