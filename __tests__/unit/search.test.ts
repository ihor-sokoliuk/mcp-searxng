#!/usr/bin/env tsx

/**
 * Unit Tests: search.ts
 * 
 * Tests for SearXNG search functionality
 */

import { strict as assert } from 'node:assert';
import { performWebSearch } from '../../src/search.js';
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
      assert.ok(error.message.includes('Configuration Error') || error.message.includes('Invalid SEARXNG_URL'));
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
      await performWebSearch(mockServer as any, 'test query', 2, 'day', 'en', '1');
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
