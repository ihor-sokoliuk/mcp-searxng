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

  await testFunction('Character pagination - maxLength', async () => {
    const mockServer = createMockServer();
    urlCache.clear();

    const testHtml = '<html><body><h1>Test Title</h1><p>This is a long paragraph with lots of content that we can paginate through.</p></body></html>';
    fetchMocker.mock(createMockFetch({ body: testHtml }));

    const result = await fetchAndConvertToMarkdown(mockServer as any, 'https://test-char-pagination.com', 10000, { maxLength: 20 });
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

  await testFunction('Character pagination - both startChar and maxLength', async () => {
    const mockServer = createMockServer();
    urlCache.clear();

    const testHtml = '<html><body><p>Content for pagination test.</p></body></html>';
    fetchMocker.mock(createMockFetch({ body: testHtml }));

    const result = await fetchAndConvertToMarkdown(mockServer as any, 'https://test-both.com', 10000, { startChar: 5, maxLength: 15 });
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
    const result1 = await fetchAndConvertToMarkdown(mockServer as any, 'https://cache-test.com', 10000, { maxLength: 50 });
    assert.equal(fetchCount, 1);
    assert.ok(typeof result1 === 'string');

    // Second request with different pagination should use cache
    const result2 = await fetchAndConvertToMarkdown(mockServer as any, 'https://cache-test.com', 10000, { startChar: 10, maxLength: 30 });
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

  await testFunction('hardened mode blocks localhost URL reads', async () => {
    const mockServer = createMockServer();
    envManager.set('MCP_HTTP_HARDEN', 'true');
    envManager.delete('MCP_HTTP_ALLOW_PRIVATE_URLS');

    try {
      await fetchAndConvertToMarkdown(mockServer as any, 'http://127.0.0.1:8080/private');
      assert.fail('Expected localhost URL to be blocked');
    } catch (error: any) {
      assert.ok(error.message.includes('blocked by security policy'));
    }

    envManager.restore();
  }, results);

  await testFunction('override allows localhost URL reads in hardened mode', async () => {
    const mockServer = createMockServer();
    urlCache.clear();
    envManager.set('MCP_HTTP_HARDEN', 'true');
    envManager.set('MCP_HTTP_ALLOW_PRIVATE_URLS', 'true');

    fetchMocker.mock(createMockFetch({ body: '<html><body><h1>Internal</h1></body></html>' }));
    const result = await fetchAndConvertToMarkdown(mockServer as any, 'http://127.0.0.1:8080/private');
    assert.ok(result.includes('Internal'));

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('Section extraction - existing section', async () => {
    const mockServer = createMockServer();
    urlCache.clear();

    const testHtml = `
      <html><body>
        <h1>Introduction</h1><p>Intro paragraph.</p>
        <h2>Installation</h2><p>Install steps here.</p>
        <h2>Usage</h2><p>Usage details here.</p>
      </body></html>
    `;
    fetchMocker.mock(createMockFetch({ body: testHtml }));

    const result = await fetchAndConvertToMarkdown(
      mockServer as any, 'https://test-section-1.com', 10000,
      { section: 'Installation' }
    );
    assert.ok(result.includes('Installation'), `Expected "Installation" in: ${result}`);
    assert.ok(!result.includes('Usage'), `Expected "Usage" NOT in section result`);

    fetchMocker.restore();
  }, results);

  await testFunction('Section extraction - section not found returns message', async () => {
    const mockServer = createMockServer();
    urlCache.clear();

    const testHtml = '<html><body><h1>Overview</h1><p>Text.</p></body></html>';
    fetchMocker.mock(createMockFetch({ body: testHtml }));

    const result = await fetchAndConvertToMarkdown(
      mockServer as any, 'https://test-section-2.com', 10000,
      { section: 'NonExistentSection' }
    );
    assert.ok(result.includes('not found'), `Expected "not found" message, got: ${result}`);

    fetchMocker.restore();
  }, results);

  await testFunction('Section extraction - treats regex metacharacters as literals', async () => {
    const mockServer = createMockServer();
    urlCache.clear();

    const testHtml = `
      <html><body>
        <h1>Overview</h1><p>Intro paragraph.</p>
        <h2>API (v1.0+) reference?</h2><p>Literal metacharacter heading content.</p>
        <h2>API v100 referencex</h2><p>Regex-like near miss should not be selected.</p>
      </body></html>
    `;
    fetchMocker.mock(createMockFetch({ body: testHtml }));

    const result = await fetchAndConvertToMarkdown(
      mockServer as any, 'https://test-section-metacharacters.com', 10000,
      { section: 'API (v1.0+) reference?' }
    );
    assert.ok(result.includes('API (v1.0+) reference?'), `Expected literal heading match, got: ${result}`);
    assert.ok(result.includes('Literal metacharacter heading content'), `Expected matching section body, got: ${result}`);
    assert.ok(!result.includes('Regex-like near miss'), 'Expected regex-like near miss to be excluded');

    fetchMocker.restore();
  }, results);

  await testFunction('Paragraph range - single paragraph', async () => {
    const mockServer = createMockServer();
    urlCache.clear();

    const testHtml = '<html><body><p>First paragraph.</p><p>Second paragraph.</p><p>Third paragraph.</p></body></html>';
    fetchMocker.mock(createMockFetch({ body: testHtml }));

    const result = await fetchAndConvertToMarkdown(
      mockServer as any, 'https://test-para-1.com', 10000,
      { paragraphRange: '1' }
    );
    assert.ok(result.includes('First paragraph'), `Expected first paragraph, got: ${result}`);
    assert.ok(!result.includes('Second paragraph'), `Expected only first paragraph`);

    fetchMocker.restore();
  }, results);

  await testFunction('Paragraph range - specific range', async () => {
    const mockServer = createMockServer();
    urlCache.clear();

    const testHtml = '<html><body><p>Para one.</p><p>Para two.</p><p>Para three.</p><p>Para four.</p></body></html>';
    fetchMocker.mock(createMockFetch({ body: testHtml }));

    const result = await fetchAndConvertToMarkdown(
      mockServer as any, 'https://test-para-2.com', 10000,
      { paragraphRange: '2-3' }
    );
    assert.ok(result.includes('Para two'), `Expected para two, got: ${result}`);
    assert.ok(result.includes('Para three'), `Expected para three, got: ${result}`);
    assert.ok(!result.includes('Para one'), `Expected para one excluded`);

    fetchMocker.restore();
  }, results);

  await testFunction('Paragraph range - range to end', async () => {
    const mockServer = createMockServer();
    urlCache.clear();

    const testHtml = '<html><body><p>Alpha.</p><p>Beta.</p><p>Gamma.</p></body></html>';
    fetchMocker.mock(createMockFetch({ body: testHtml }));

    const result = await fetchAndConvertToMarkdown(
      mockServer as any, 'https://test-para-3.com', 10000,
      { paragraphRange: '2-' }
    );
    assert.ok(result.includes('Beta'), `Expected Beta, got: ${result}`);
    assert.ok(result.includes('Gamma'), `Expected Gamma, got: ${result}`);
    assert.ok(!result.includes('Alpha'), `Expected Alpha excluded`);

    fetchMocker.restore();
  }, results);

  await testFunction('Paragraph range - out of bounds returns message', async () => {
    const mockServer = createMockServer();
    urlCache.clear();

    const testHtml = '<html><body><p>Only one paragraph.</p></body></html>';
    fetchMocker.mock(createMockFetch({ body: testHtml }));

    const result = await fetchAndConvertToMarkdown(
      mockServer as any, 'https://test-para-4.com', 10000,
      { paragraphRange: '99' }
    );
    assert.ok(result.includes('invalid') || result.includes('out of bounds'), `Expected out-of-bounds message, got: ${result}`);

    fetchMocker.restore();
  }, results);

  await testFunction('readHeadings option returns heading list', async () => {
    const mockServer = createMockServer();
    urlCache.clear();

    const testHtml = `
      <html><body>
        <h1>Main Title</h1>
        <h2>Chapter One</h2>
        <h3>Section A</h3>
        <p>Some paragraph text that should not appear.</p>
        <h2>Chapter Two</h2>
      </body></html>
    `;
    fetchMocker.mock(createMockFetch({ body: testHtml }));

    const result = await fetchAndConvertToMarkdown(
      mockServer as any, 'https://test-headings-1.com', 10000,
      { readHeadings: true }
    );
    assert.ok(result.includes('Main Title'), `Expected Main Title, got: ${result}`);
    assert.ok(result.includes('Chapter One'), `Expected Chapter One, got: ${result}`);
    assert.ok(!result.includes('Some paragraph text'), `Paragraph should be excluded`);

    fetchMocker.restore();
  }, results);

  await testFunction('readHeadings with no headings returns message', async () => {
    const mockServer = createMockServer();
    urlCache.clear();

    const testHtml = '<html><body><p>Only plain text, no headings here.</p></body></html>';
    fetchMocker.mock(createMockFetch({ body: testHtml }));

    const result = await fetchAndConvertToMarkdown(
      mockServer as any, 'https://test-headings-2.com', 10000,
      { readHeadings: true }
    );
    assert.ok(result.includes('No headings found'), `Expected "No headings found", got: ${result}`);

    fetchMocker.restore();
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
