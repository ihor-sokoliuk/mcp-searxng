#!/usr/bin/env tsx

/**
 * Unit Tests: search.ts
 * 
 * Tests for SearXNG search functionality
 */

import { strict as assert } from 'node:assert';
import { fileURLToPath } from 'node:url';
import { performWebSearch } from '../../src/search.js';
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
