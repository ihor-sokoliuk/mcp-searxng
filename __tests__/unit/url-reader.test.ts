#!/usr/bin/env tsx

/**
 * Unit Tests: url-reader.ts
 * 
 * Tests for URL fetching and markdown conversion
 */

import { strict as assert } from 'node:assert';
import { fetchAndConvertToMarkdown } from '../../src/url-reader.js';
import { urlCache } from '../../src/cache.js';
import { testFunction, createTestResults, printTestSummary } from '../helpers/test-utils.js';
import { createMockServer } from '../helpers/mock-server.js';
import { FetchMocker, createMockFetch, createAbortableMockFetch } from '../helpers/mock-fetch.js';
import { EnvManager } from '../helpers/env-utils.js';

const results = createTestResults();
const fetchMocker = new FetchMocker();
const envManager = new EnvManager();

async function runTests() {
  console.log('🧪 Testing: url-reader.ts\n');

  await testFunction('Error handling for invalid URL', async () => {
    const mockServer = createMockServer();
    
    try {
      await fetchAndConvertToMarkdown(mockServer as any, 'not-a-valid-url');
      assert.fail('Should have thrown URL format error');
    } catch (error: any) {
      assert.ok(error.message.includes('URL Format Error') || error.message.includes('Invalid URL'));
    }
  }, results);

  await testFunction('Various invalid URL formats', async () => {
    const mockServer = createMockServer();
    const invalidUrls = ['', 'not-a-url', 'invalid://protocol'];

    for (const invalidUrl of invalidUrls) {
      try {
        await fetchAndConvertToMarkdown(mockServer as any, invalidUrl);
        assert.fail(`Should have thrown error for invalid URL: ${invalidUrl}`);
      } catch (error: any) {
        assert.ok(error.message.includes('URL Format Error') || error.message.includes('Invalid URL') || error.name === 'MCPSearXNGError');
      }
    }
  }, results);

  await testFunction('Network error handling', async () => {
    const mockServer = createMockServer();
    const networkErrors = [
      { code: 'ECONNREFUSED', message: 'Connection refused' },
      { code: 'ETIMEDOUT', message: 'Request timeout' },
      { code: 'ENOTFOUND', message: 'DNS resolution failed' },
      { code: 'ECONNRESET', message: 'Connection reset' }
    ];

    for (const networkError of networkErrors) {
      const error = new Error(networkError.message);
      (error as any).code = networkError.code;
      
      fetchMocker.mock(createMockFetch({ throwError: error }));

      try {
        await fetchAndConvertToMarkdown(mockServer as any, 'https://example.com');
        assert.fail(`Should have thrown network error for ${networkError.code}`);
      } catch (error: any) {
        assert.ok(error.message.includes('Network Error') || error.message.includes('Connection') || error.name === 'MCPSearXNGError');
      }

      fetchMocker.restore();
    }
  }, results);

  await testFunction('HTTP error status codes', async () => {
    const mockServer = createMockServer();
    const statusCodes = [404, 403, 500, 502, 503, 429];

    for (const statusCode of statusCodes) {
      fetchMocker.mock(createMockFetch({
        ok: false,
        status: statusCode,
        statusText: `HTTP ${statusCode}`,
        body: `Error ${statusCode} response body`
      }));

      try {
        await fetchAndConvertToMarkdown(mockServer as any, 'https://example.com');
        assert.fail(`Should have thrown server error for status ${statusCode}`);
      } catch (error: any) {
        assert.ok(error.message.includes('Server Error') || error.message.includes(`${statusCode}`) || error.name === 'MCPSearXNGError');
      }

      fetchMocker.restore();
    }
  }, results);

  await testFunction('Timeout handling', async () => {
    const mockServer = createMockServer();
    
    fetchMocker.mock(createAbortableMockFetch(50));

    try {
      await fetchAndConvertToMarkdown(mockServer as any, 'https://example.com', 100);
      assert.fail('Should have thrown timeout error');
    } catch (error: any) {
      assert.ok(error.message.includes('Timeout Error') || error.message.includes('timeout') || error.name === 'MCPSearXNGError');
    }

    fetchMocker.restore();
  }, results);

  await testFunction('Empty content handling', async () => {
    const mockServer = createMockServer();
    
    // Test empty HTML content
    fetchMocker.mock(createMockFetch({ body: '' }));

    try {
      await fetchAndConvertToMarkdown(mockServer as any, 'https://example.com');
      assert.fail('Should have thrown content error for empty content');
    } catch (error: any) {
      assert.ok(error.message.includes('Content Error') || error.message.includes('empty') || error.name === 'MCPSearXNGError');
    }

    fetchMocker.restore();
  }, results);

  await testFunction('Whitespace-only content handling', async () => {
    const mockServer = createMockServer();
    
    fetchMocker.mock(createMockFetch({ body: '   \n\t   ' }));

    try {
      await fetchAndConvertToMarkdown(mockServer as any, 'https://example.com');
      assert.fail('Should have thrown content error for whitespace-only content');
    } catch (error: any) {
      assert.ok(error.message.includes('Content Error') || error.message.includes('empty') || error.name === 'MCPSearXNGError');
    }

    fetchMocker.restore();
  }, results);

  await testFunction('Successful HTML to Markdown conversion', async () => {
    const mockServer = createMockServer();
    urlCache.clear();
    
    const testHtml = `
      <html>
        <head><title>Test Page</title></head>
        <body>
          <h1>Main Title</h1>
          <p>This is a test paragraph with <strong>bold text</strong>.</p>
          <ul>
            <li>First item</li>
            <li>Second item</li>
          </ul>
          <a href="https://example.com">Test Link</a>
        </body>
      </html>
    `;

    fetchMocker.mock(createMockFetch({ body: testHtml }));

    const result = await fetchAndConvertToMarkdown(mockServer as any, 'https://example.com');
    assert.ok(typeof result === 'string');
    assert.ok(result.length > 0);
    // Check for markdown conversion
    assert.ok(result.includes('Main Title') || result.includes('#'));

    fetchMocker.restore();
  }, results);

  await testFunction('Character pagination - max_length', async () => {
    const mockServer = createMockServer();
    urlCache.clear();

    const testHtml = '<html><body><h1>Test Title</h1><p>This is a long paragraph with lots of content that we can paginate through.</p></body></html>';
    fetchMocker.mock(createMockFetch({ body: testHtml }));

    const result = await fetchAndConvertToMarkdown(mockServer as any, 'https://test-char-pagination.com', 10000, { max_length: 20 });
    assert.ok(typeof result === 'string');
    assert.ok(result.length <= 20, `Expected length <= 20, got ${result.length}`);

    fetchMocker.restore();
  }, results);

  await testFunction('Character pagination - startChar', async () => {
    const mockServer = createMockServer();
    urlCache.clear();

    const testHtml = '<html><body><h1>Test Title</h1><p>Content here.</p></body></html>';
    fetchMocker.mock(createMockFetch({ body: testHtml }));

    const result = await fetchAndConvertToMarkdown(mockServer as any, 'https://test-start.com', 10000, { startChar: 10 });
    assert.ok(typeof result === 'string');

    fetchMocker.restore();
  }, results);

  await testFunction('Character pagination - both startChar and max_length', async () => {
    const mockServer = createMockServer();
    urlCache.clear();

    const testHtml = '<html><body><p>Content for pagination test.</p></body></html>';
    fetchMocker.mock(createMockFetch({ body: testHtml }));

    const result = await fetchAndConvertToMarkdown(mockServer as any, 'https://test-both.com', 10000, { startChar: 5, max_length: 15 });
    assert.ok(typeof result === 'string');
    assert.ok(result.length <= 15, `Expected length <= 15, got ${result.length}`);

    fetchMocker.restore();
  }, results);

  await testFunction('Cache integration with pagination', async () => {
    const mockServer = createMockServer();
    urlCache.clear();

    let fetchCount = 0;
    const testHtml = '<html><body><h1>Cached Content</h1><p>This content should be cached.</p></body></html>';

    fetchMocker.mock(async () => {
      fetchCount++;
      return createMockFetch({ body: testHtml })('', undefined);
    });

    // First request should fetch from network
    const result1 = await fetchAndConvertToMarkdown(mockServer as any, 'https://cache-test.com', 10000, { max_length: 50 });
    assert.equal(fetchCount, 1);
    assert.ok(typeof result1 === 'string');

    // Second request with different pagination should use cache
    const result2 = await fetchAndConvertToMarkdown(mockServer as any, 'https://cache-test.com', 10000, { startChar: 10, max_length: 30 });
    assert.equal(fetchCount, 1); // Should not have fetched again

    fetchMocker.restore();
    urlCache.clear();
  }, results);

  await testFunction('Proxy agent integration', async () => {
    const mockServer = createMockServer();
    urlCache.clear();

    envManager.set('HTTPS_PROXY', 'https://proxy.example.com:8080');
    
    let capturedOptions: RequestInit | undefined;
    fetchMocker.mock(async (url: string | URL | Request, options?: RequestInit) => {
      capturedOptions = options;
      return createMockFetch({ body: '<html><body><h1>Test with proxy</h1></body></html>' })('', undefined);
    });

    await fetchAndConvertToMarkdown(mockServer as any, 'https://example.com');
    assert.ok(capturedOptions !== undefined);
    assert.ok(capturedOptions?.signal instanceof AbortSignal);

    fetchMocker.restore();
    envManager.restore();
  }, results);

  printTestSummary(results, 'URL Reader Module');
  return results;
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runTests().then(results => {
    process.exit(results.failed > 0 ? 1 : 0);
  }).catch(console.error);
}

export { runTests };
