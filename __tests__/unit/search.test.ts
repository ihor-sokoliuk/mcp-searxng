#!/usr/bin/env tsx

/**
 * Unit Tests: search.ts
 * 
 * Tests for SearXNG search functionality
 */

import { strict as assert } from 'node:assert';
import { performWebSearch } from '../../src/search.js';
import { isSearXNGWebSearchArgs } from '../../src/types.js';
import { testFunction, createTestResults, printTestSummary } from '../helpers/test-utils.js';
import { createMockServer } from '../helpers/mock-server.js';
import { FetchMocker, createMockFetch, createCapturingMockFetch } from '../helpers/mock-fetch.js';
import { EnvManager } from '../helpers/env-utils.js';

const results = createTestResults();
const fetchMocker = new FetchMocker();
const envManager = new EnvManager();

async function runTests() {
  console.log('🧪 Testing: search.ts\n');

  await testFunction('Error handling for missing SEARXNG_URL', async () => {
    envManager.delete('SEARXNG_URL');
    
    const mockServer = createMockServer();
    
    try {
      await performWebSearch(mockServer as any, 'test query', 1, undefined, 'all', undefined, undefined, 'full');
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
    const { mockFetch, getCapturedUrl, getCapturedOptions } = createCapturingMockFetch();

    fetchMocker.mock(async (url, options) => {
      const result = await mockFetch(url, options);
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
      const result = await mockFetch(url, options);
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
    assert.ok(result.includes('https://example.com/1'));
    assert.ok(result.includes('https://example.com/2'));

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


  await testFunction('Categories parameter added to URL', async () => {
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');
    
    const mockServer = createMockServer();
    const { mockFetch, getCapturedUrl } = createCapturingMockFetch();

    fetchMocker.mock(async (url, options) => {
      await mockFetch(url, options);
      throw new Error('MOCK_NETWORK_ERROR');
    });

    try {
      await performWebSearch(mockServer as any, 'test query', 1, undefined, 'all', undefined, 'news');
    } catch (error: any) {
      // Expected to fail with mock error
    }

    const url = new URL(getCapturedUrl());
    assert.ok(url.searchParams.get('categories') === 'news', `Expected categories=news, got ${url.searchParams.get('categories')}`);

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('No categories param when omitted', async () => {
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');
    
    const mockServer = createMockServer();
    const { mockFetch, getCapturedUrl } = createCapturingMockFetch();

    fetchMocker.mock(async (url, options) => {
      await mockFetch(url, options);
      throw new Error('MOCK_NETWORK_ERROR');
    });

    try {
      await performWebSearch(mockServer as any, 'test query');
    } catch (error: any) {
      // Expected
    }

    const url = new URL(getCapturedUrl());
    assert.ok(url.searchParams.get('categories') === null, `Expected no categories param, got ${url.searchParams.get('categories')}`);

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('Empty categories string not sent', async () => {
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');
    
    const mockServer = createMockServer();
    const { mockFetch, getCapturedUrl } = createCapturingMockFetch();
    fetchMocker.mock(async (url, options) => {
      await mockFetch(url, options);
      throw new Error('MOCK_NETWORK_ERROR');
    });

    try {
      await performWebSearch(mockServer as any, 'test query', 1, undefined, 'all', undefined, '');
    } catch (error: any) {
      // Expected
    }

    const url = new URL(getCapturedUrl());
    assert.ok(url.searchParams.get('categories') === null, `Expected no categories for empty string`);

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('Passthrough formatting - all non-null fields present', async () => {
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');
    
    const mockServer = createMockServer();
    const mockFetch = createMockFetch({
      json: {
        results: [
          { title: 'Test', url: 'https://example.com', score: 0.95, thumbnail_src: 'https://img.example.com/thumb.jpg', publishedDate: '2025-01-15', engine: 'google', engines: ['google', 'bing'] }
        ]
      }
    });
    fetchMocker.mock(mockFetch);

    const result = await performWebSearch(mockServer as any, 'test query', 1, undefined, 'all', undefined, undefined, 'full');
    assert.ok(result.includes('title: Test'));
    assert.ok(result.includes('url: https://example.com'));
    assert.ok(result.includes('score: 0.95'));
    assert.ok(result.includes('thumbnail_src: https://img.example.com/thumb.jpg'));
    assert.ok(result.includes('publishedDate: 2025-01-15'));
    assert.ok(result.includes('engine: google'));
    assert.ok(result.includes('engines: google, bing'));

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('Results separated with ---', async () => {
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');
    
    const mockServer = createMockServer();
    const mockFetch = createMockFetch({
      json: {
        results: [
          { title: 'Result 1', url: 'https://example.com/1', score: 0.9 },
          { title: 'Result 2', url: 'https://example.com/2', score: 0.8 }
        ]
      }
    });
    fetchMocker.mock(mockFetch);

    const result = await performWebSearch(mockServer as any, 'test query', 1, undefined, 'all', undefined, undefined, 'full');
    assert.ok(result.includes('\n---\n'), 'Expected --- separator between results');

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('Null and empty fields excluded from output', async () => {
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');
    
    const mockServer = createMockServer();
    const mockFetch = createMockFetch({
      json: {
        results: [
          { title: 'Partial', url: 'https://example.com', content: null, score: 0.7, thumbnail_src: '' }
        ]
      }
    });
    fetchMocker.mock(mockFetch);

    const result = await performWebSearch(mockServer as any, 'test query', 1, undefined, 'all', undefined, undefined, 'full');
    assert.ok(result.includes('title: Partial'));
    assert.ok(result.includes('url: https://example.com'));
    assert.ok(result.includes('score: 0.7'));
    assert.ok(!result.includes('content:'));
    assert.ok(!result.includes('thumbnail_src:'));

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('Top-level answers section', async () => {
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');
    
    const mockServer = createMockServer();
    const mockFetch = createMockFetch({
      json: {
        results: [{ title: 'Test', url: 'https://example.com', score: 0.9 }],
        answers: ['Paris is the capital of France.']
      }
    });
    fetchMocker.mock(mockFetch);

    const result = await performWebSearch(mockServer as any, 'capital of france', 1, undefined, 'all', undefined, undefined, 'full');
    assert.ok(result.includes('## Answers'));
    assert.ok(result.includes('- Paris is the capital of France.'));

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('Top-level suggestions section', async () => {
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');
    
    const mockServer = createMockServer();
    const mockFetch = createMockFetch({
      json: {
        results: [{ title: 'Test', url: 'https://example.com', score: 0.9 }],
        suggestions: ['related query 1', 'related query 2']
      }
    });
    fetchMocker.mock(mockFetch);

    const result = await performWebSearch(mockServer as any, 'test', 1, undefined, 'all', undefined, undefined, 'full');
    assert.ok(result.includes('## Suggestions'));
    assert.ok(result.includes('- related query 1'));
    assert.ok(result.includes('- related query 2'));

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('Top-level corrections and infoboxes', async () => {
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');
    
    const mockServer = createMockServer();
    const mockFetch = createMockFetch({
      json: {
        results: [{ title: 'Test', url: 'https://example.com', score: 0.9 }],
        corrections: ['corrected query'],
        infoboxes: [{ title: 'France', content: 'French Republic', urls: [{ title: 'Wikipedia', url: 'https://en.wikipedia.org/wiki/France' }] }]
      }
    });
    fetchMocker.mock(mockFetch);

    const result = await performWebSearch(mockServer as any, 'france', 1, undefined, 'all', undefined, undefined, 'full');
    assert.ok(result.includes('## Corrections'));
    assert.ok(result.includes('- corrected query'));
    assert.ok(result.includes('## Infoboxes'));
    assert.ok(result.includes('France'));

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('No top-level sections when absent', async () => {
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');
    
    const mockServer = createMockServer();
    const mockFetch = createMockFetch({
      json: {
        results: [{ title: 'Simple', url: 'https://example.com', score: 0.5 }]
      }
    });
    fetchMocker.mock(mockFetch);

    const result = await performWebSearch(mockServer as any, 'test');
    assert.ok(!result.includes('## Answers'));
    assert.ok(!result.includes('## Suggestions'));
    assert.ok(!result.includes('## Corrections'));
    assert.ok(!result.includes('## Infoboxes'));

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('Classic format handles invalid scores gracefully', async () => {
    envManager.set('SEARXNG_URL', 'https://test-searx.example.com');

    const mockServer = createMockServer();
    const mockFetch = createMockFetch({
      json: {
        results: [
          { title: 'BadScore', url: 'https://example.com', score: 'not a number' },
          { title: 'NullScore', url: 'https://example.com/2', score: null },
          { title: 'NoScore', url: 'https://example.com/3' }
        ]
      }
    });
    fetchMocker.mock(mockFetch);

    const result = await performWebSearch(mockServer as any, 'test query');
    assert.ok(!result.includes('NaN'), 'Score should not contain NaN');
    assert.ok(result.includes('0.000'), 'Should have fallback score');

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('Invalid categories rejected by type guard', async () => {
    assert.equal(isSearXNGWebSearchArgs({ query: 'test', categories: 'news' }), true);
    assert.equal(isSearXNGWebSearchArgs({ query: 'test', categories: 'news,images' }), true);
    assert.equal(isSearXNGWebSearchArgs({ query: 'test', categories: 'fake_category' }), false);
    assert.equal(isSearXNGWebSearchArgs({ query: 'test', categories: 'news,fake' }), false);
    assert.equal(isSearXNGWebSearchArgs({ query: 'test', categories: '../../../etc' }), false);
  }, results);

  printTestSummary(results, 'Search Module');
  return results;
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runTests().then(results => {
    process.exit(results.failed > 0 ? 1 : 0);
  }).catch(console.error);
}

export { runTests };
