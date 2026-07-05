#!/usr/bin/env tsx

/**
 * Unit Tests: url-reader.ts
 *
 * Tests for URL fetching and markdown conversion.
 *
 * Uses real local HTTP servers instead of global-fetch mocks so the tests
 * exercise the actual undici + Agent dispatch pipeline — including the
 * Content-Encoding decompression path that was broken by issue #81.
 */

import { strict as assert } from 'node:assert';
import * as http from 'node:http';
import * as net from 'node:net';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as zlib from 'node:zlib';
import { checkContentLength, fetchAndConvertToMarkdown } from '../../src/url-reader.js';
import { createUrlReaderLookup } from '../../src/proxy.js';
import { urlCache } from '../../src/cache.js';
import { testFunction, createTestResults, printTestSummary } from '../helpers/test-utils.js';
import { createMockServer } from '../helpers/mock-server.js';
import { EnvManager } from '../helpers/env-utils.js';

const results = createTestResults();
const envManager = new EnvManager();
const require = createRequire(import.meta.url);
const dnsModule = require('node:dns') as typeof import('node:dns');
const TEST_PUBLIC_IP = '93.184.216.34';

// ─── local test-server helpers ───────────────────────────────────────────────

type ServerOpts = {
  status?: number;
  headers?: Record<string, string>;
  body?: string | Buffer;
  /** Destroy the socket immediately — simulates ECONNRESET / hard close. */
  closeImmediately?: boolean;
  /** Accept the connection but never write anything — simulates a hung server. */
  hangForever?: boolean;
};

interface TestServer {
  url: string;
  close: () => Promise<void>;
}

type ServerHandler = (req: http.IncomingMessage, res: http.ServerResponse) => void;
type ConnectProxyHandler = (authority: string, requestText: string) => {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
};

function startHttpServer(handler: ServerHandler): Promise<TestServer> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as net.AddressInfo;
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () =>
          new Promise<void>((res) => {
            server.closeAllConnections();
            server.close(() => res());
          }),
      });
    });

    server.once('error', reject);
  });
}

function startConnectProxyServer(handler: ConnectProxyHandler): Promise<TestServer> {
  return new Promise((resolve, reject) => {
    const server = http.createServer();

    server.on('connect', (req, socket) => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      socket.once('data', (data) => {
        const response = handler(req.url || '', data.toString('utf8'));
        const status = response.status ?? 200;
        const headers = {
          'content-type': 'text/html; charset=utf-8',
          ...response.headers,
        };
        const headerLines = Object.entries(headers)
          .map(([key, value]) => `${key}: ${value}`)
          .join('\r\n');
        socket.end(`HTTP/1.1 ${status} OK\r\n${headerLines}\r\n\r\n${response.body ?? ''}`);
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as net.AddressInfo;
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () =>
          new Promise<void>((res) => {
            server.closeAllConnections();
            server.close(() => res());
          }),
      });
    });

    server.once('error', reject);
  });
}

function startTestServer(opts: ServerOpts = {}): Promise<TestServer> {
  return startHttpServer((req, res) => {
      if (opts.closeImmediately) {
        req.socket.destroy();
        return;
      }
      if (opts.hangForever) {
        // keep the socket open but never send any bytes
        return;
      }
      const status = opts.status ?? 200;
      const headers: Record<string, string> = {
        'content-type': 'text/html; charset=utf-8',
        ...opts.headers,
      };
      res.writeHead(status, headers);
      res.end(opts.body ?? '');
  });
}

/**
 * Grab a free TCP port (open a server on port 0, record the assigned port,
 * then close it). Connecting to this port right after will get ECONNREFUSED.
 */
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.once('error', reject);
  });
}

type MockDnsRecords = Record<string, Array<{ address: string; family: 4 | 6 }>>;

function installDnsLookupMock(recordsByHostname: MockDnsRecords): () => void {
  const originalLookup = dnsModule.lookup;

  (dnsModule as any).lookup = (hostname: string, options: any, callback?: any) => {
    const cb = typeof options === 'function' ? options : callback;
    if (net.isIP(hostname)) {
      return (originalLookup as any).call(dnsModule, hostname, options, callback);
    }

    const records = recordsByHostname[hostname];

    if (!records) {
      const err = new Error(`Mock DNS has no records for ${hostname}`) as NodeJS.ErrnoException;
      err.code = 'ENOTFOUND';
      cb(err);
      return;
    }

    if (options?.all) {
      cb(null, records);
      return;
    }

    const first = records[0];
    cb(null, first.address, first.family);
  };
  syncBuiltinESMExports();

  return () => {
    (dnsModule as any).lookup = originalLookup;
    syncBuiltinESMExports();
  };
}

// ─── tests ───────────────────────────────────────────────────────────────────

async function runTests() {
  console.log('🧪 Testing: url-reader.ts\n');
  const originalAllowPrivateUrls = process.env.MCP_HTTP_ALLOW_PRIVATE_URLS;
  process.env.MCP_HTTP_ALLOW_PRIVATE_URLS = 'true';

  // ── invalid URLs (blocked before any network call) ────────────────────────

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
        assert.ok(
          error.message.includes('URL Format Error') ||
          error.message.includes('Invalid URL') ||
          error.name === 'MCPSearXNGError',
        );
      }
    }
  }, results);

  // ── network-error wrapping ────────────────────────────────────────────────

  await testFunction('Network error handling', async () => {
    const mockServer = createMockServer();
    // Obtain a free port then release it — connecting right after yields ECONNREFUSED.
    const port = await getFreePort();
    try {
      await fetchAndConvertToMarkdown(mockServer as any, `http://127.0.0.1:${port}`);
      assert.fail('Should have thrown a network error');
    } catch (error: any) {
      assert.ok(
        error.message.includes('Network Error') ||
        error.message.includes('Connection') ||
        error.name === 'MCPSearXNGError',
        `Unexpected error: ${error.message}`,
      );
    }
  }, results);

  // ── HTTP error status codes ───────────────────────────────────────────────

  await testFunction('HTTP error status codes', async () => {
    const mockServer = createMockServer();
    const statusCodes = [404, 403, 500, 502, 503, 429];

    for (const statusCode of statusCodes) {
      const { url, close } = await startTestServer({
        status: statusCode,
        body: `Error ${statusCode} response body`,
      });
      try {
        await fetchAndConvertToMarkdown(mockServer as any, url);
        assert.fail(`Should have thrown server error for status ${statusCode}`);
      } catch (error: any) {
        assert.ok(
          error.message.includes('Server Error') ||
          error.message.includes(`${statusCode}`) ||
          error.name === 'MCPSearXNGError',
          `Unexpected error for ${statusCode}: ${error.message}`,
        );
      } finally {
        await close();
      }
    }
  }, results);

  // ── timeout ───────────────────────────────────────────────────────────────

  await testFunction('Timeout handling', async () => {
    const mockServer = createMockServer();
    const { url, close } = await startTestServer({ hangForever: true });
    try {
      await fetchAndConvertToMarkdown(mockServer as any, url, 100);
      assert.fail('Should have thrown timeout error');
    } catch (error: any) {
      assert.ok(
        error.message.includes('Timeout Error') ||
        error.message.includes('timeout') ||
        error.name === 'MCPSearXNGError',
        `Unexpected error: ${error.message}`,
      );
    } finally {
      await close();
    }
  }, results);

  // ── HEAD content-length preflight ─────────────────────────────────────────

  await testFunction('HEAD preflight returns Content-Length when present', async () => {
    const mockServer = createMockServer();
    const { url, close } = await startHttpServer((req, res) => {
      if (req.method === 'HEAD') {
        res.writeHead(200, { 'content-length': '1234' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><body>GET fallback</body></html>');
    });

    try {
      const contentLength = await checkContentLength(mockServer as any, url, 1000);
      assert.equal(contentLength, 1234);
    } finally {
      await close();
    }
  }, results);

  await testFunction('HEAD preflight returns null when Content-Length is absent', async () => {
    const mockServer = createMockServer();
    const { url, close } = await startHttpServer((req, res) => {
      if (req.method === 'HEAD') {
        res.writeHead(200);
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><body>GET fallback</body></html>');
    });

    try {
      const contentLength = await checkContentLength(mockServer as any, url, 1000);
      assert.equal(contentLength, null);
    } finally {
      await close();
    }
  }, results);

  await testFunction('HEAD preflight failure is non-fatal and returns null', async () => {
    const mockServer = createMockServer();
    const port = await getFreePort();

    const contentLength = await checkContentLength(mockServer as any, `http://127.0.0.1:${port}`, 100);

    assert.equal(contentLength, null);
  }, results);

  await testFunction('HEAD preflight blocks GET when Content-Length exceeds URL_READ_MAX_CONTENT_LENGTH_BYTES', async () => {
    const mockServer = createMockServer();
    urlCache.clear();
    envManager.set('URL_READ_MAX_CONTENT_LENGTH_BYTES', '100');

    const seenMethods: string[] = [];
    const { url, close } = await startHttpServer((req, res) => {
      seenMethods.push(req.method || 'UNKNOWN');
      if (req.method === 'HEAD') {
        res.writeHead(200, { 'content-length': '101' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><body><h1>Should not download</h1></body></html>');
    });

    try {
      const result = await fetchAndConvertToMarkdown(mockServer as any, url);
      assert.ok(result.includes('Content too large'));
      assert.ok(result.includes('0.00 MB'));
      assert.deepEqual(seenMethods, ['HEAD']);
    } finally {
      await close();
      envManager.restore();
      urlCache.clear();
    }
  }, results);

  await testFunction('HEAD preflight allows GET when Content-Length is within limit', async () => {
    const mockServer = createMockServer();
    urlCache.clear();
    envManager.set('URL_READ_MAX_CONTENT_LENGTH_BYTES', '1000');

    const seenMethods: string[] = [];
    const { url, close } = await startHttpServer((req, res) => {
      seenMethods.push(req.method || 'UNKNOWN');
      if (req.method === 'HEAD') {
        res.writeHead(200, { 'content-length': '1000' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><body><h1>Allowed Content</h1></body></html>');
    });

    try {
      const result = await fetchAndConvertToMarkdown(mockServer as any, url);
      assert.ok(result.includes('Allowed Content'));
      assert.deepEqual(seenMethods, ['HEAD', 'GET']);
    } finally {
      await close();
      envManager.restore();
      urlCache.clear();
    }
  }, results);

  await testFunction('Streaming GET body without Content-Length is capped', async () => {
    const mockServer = createMockServer();
    urlCache.clear();
    envManager.set('URL_READ_MAX_CONTENT_LENGTH_BYTES', '64');

    const seenMethods: string[] = [];
    const { url, close } = await startHttpServer((req, res) => {
      seenMethods.push(req.method || 'UNKNOWN');
      if (req.method === 'HEAD') {
        res.writeHead(200);
        res.end();
        return;
      }

      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.write('<html><body><h1>Chunked</h1>');
      res.write('x'.repeat(128));
      res.end('</body></html>');
    });

    try {
      const result = await fetchAndConvertToMarkdown(mockServer as any, url);
      assert.ok(result.includes('Content too large'), `Expected content-too-large message, got: ${result}`);
      assert.deepEqual(seenMethods, ['HEAD', 'GET']);
    } finally {
      await close();
      envManager.restore();
      urlCache.clear();
    }
  }, results);

  await testFunction('Streaming GET body with understated HEAD Content-Length is capped', async () => {
    const mockServer = createMockServer();
    urlCache.clear();
    envManager.set('URL_READ_MAX_CONTENT_LENGTH_BYTES', '64');

    const seenMethods: string[] = [];
    const { url, close } = await startHttpServer((req, res) => {
      seenMethods.push(req.method || 'UNKNOWN');
      if (req.method === 'HEAD') {
        res.writeHead(200, { 'content-length': '10' });
        res.end();
        return;
      }

      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.write('<html><body><h1>Understated</h1>');
      res.write('x'.repeat(128));
      res.end('</body></html>');
    });

    try {
      const result = await fetchAndConvertToMarkdown(mockServer as any, url);
      assert.ok(result.includes('Content too large'), `Expected content-too-large message, got: ${result}`);
      assert.deepEqual(seenMethods, ['HEAD', 'GET']);
    } finally {
      await close();
      envManager.restore();
      urlCache.clear();
    }
  }, results);

  await testFunction('Streaming GET body just under limit is returned in full', async () => {
    const mockServer = createMockServer();
    urlCache.clear();
    envManager.set('URL_READ_MAX_CONTENT_LENGTH_BYTES', '128');

    const html = '<html><body><h1>Within Limit</h1><p>Complete body.</p></body></html>';
    const { url, close } = await startHttpServer((req, res) => {
      if (req.method === 'HEAD') {
        res.writeHead(200);
        res.end();
        return;
      }

      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
    });

    try {
      assert.ok(Buffer.byteLength(html, 'utf8') < 128, 'Test body must stay below configured cap');
      const result = await fetchAndConvertToMarkdown(mockServer as any, url);
      assert.ok(result.includes('Within Limit'), `Expected converted content, got: ${result}`);
      assert.ok(result.includes('Complete body'), `Expected complete converted body, got: ${result}`);
    } finally {
      await close();
      envManager.restore();
      urlCache.clear();
    }
  }, results);

  await testFunction('Over-limit streaming GET result is not cached', async () => {
    const mockServer = createMockServer();
    urlCache.clear();
    envManager.set('URL_READ_MAX_CONTENT_LENGTH_BYTES', '64');

    let headCount = 0;
    let getCount = 0;
    const { url, close } = await startHttpServer((req, res) => {
      if (req.method === 'HEAD') {
        headCount++;
        res.writeHead(200);
        res.end();
        return;
      }

      getCount++;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.write('<html><body><h1>Not cached</h1>');
      res.write('x'.repeat(128));
      res.end('</body></html>');
    });

    try {
      const first = await fetchAndConvertToMarkdown(mockServer as any, url);
      const second = await fetchAndConvertToMarkdown(mockServer as any, url);

      assert.ok(first.includes('Content too large'), `Expected first read to be capped, got: ${first}`);
      assert.ok(second.includes('Content too large'), `Expected second read to be capped, got: ${second}`);
      assert.equal(headCount, 2, 'Second over-limit read should repeat HEAD instead of using cache');
      assert.equal(getCount, 2, 'Second over-limit read should re-fetch instead of using cache');
    } finally {
      await close();
      envManager.restore();
      urlCache.clear();
    }
  }, results);

  await testFunction('Oversized HTTP error response body is capped', async () => {
    const mockServer = createMockServer();
    urlCache.clear();
    envManager.set('URL_READ_MAX_CONTENT_LENGTH_BYTES', '64');

    let chunksWritten = 0;
    let responseClosed = false;
    let resolveResponseClosed: () => void = () => {};
    const responseClosedPromise = new Promise<void>((resolve) => {
      resolveResponseClosed = resolve;
    });
    const totalChunks = 100;
    const { url, close } = await startHttpServer((req, res) => {
      if (req.method === 'HEAD') {
        res.writeHead(500);
        res.end();
        return;
      }

      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.on('close', () => {
        responseClosed = true;
        resolveResponseClosed();
      });

      const writeNext = () => {
        if (res.destroyed || chunksWritten >= totalChunks) {
          res.end();
          return;
        }

        chunksWritten++;
        res.write('x'.repeat(32));
        setImmediate(writeNext);
      };

      writeNext();
    });

    try {
      await fetchAndConvertToMarkdown(mockServer as any, url);
      assert.fail('Expected server error');
    } catch (error: any) {
      assert.ok(
        error.message.includes('Website Error (500)') || error.name === 'MCPSearXNGError',
        `Expected server error, got: ${error.message}`,
      );
      await Promise.race([
        responseClosedPromise,
        new Promise<void>((resolve) => setTimeout(resolve, 50)),
      ]);
      assert.ok(responseClosed, 'Expected response stream to be closed');
      assert.ok(chunksWritten < totalChunks, `Expected capped error-body read, wrote all ${chunksWritten} chunks`);
    } finally {
      await close();
      envManager.restore();
      urlCache.clear();
    }
  }, results);

  await testFunction('Invalid URL_READ_MAX_CONTENT_LENGTH_BYTES falls back to default cap', async () => {
    const mockServer = createMockServer();
    urlCache.clear();
    envManager.set('URL_READ_MAX_CONTENT_LENGTH_BYTES', 'not-a-number');

    const seenMethods: string[] = [];
    const { url, close } = await startHttpServer((req, res) => {
      seenMethods.push(req.method || 'UNKNOWN');
      if (req.method === 'HEAD') {
        res.writeHead(200, { 'content-length': String(6 * 1024 * 1024) });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><body><h1>Should not download</h1></body></html>');
    });

    try {
      const result = await fetchAndConvertToMarkdown(mockServer as any, url);
      assert.ok(result.includes('Content too large'));
      assert.deepEqual(seenMethods, ['HEAD']);
    } finally {
      await close();
      envManager.restore();
      urlCache.clear();
    }
  }, results);

  // ── empty / whitespace body ───────────────────────────────────────────────

  await testFunction('Empty content handling', async () => {
    const mockServer = createMockServer();
    urlCache.clear();
    const { url, close } = await startTestServer({ body: '' });
    try {
      await fetchAndConvertToMarkdown(mockServer as any, url);
      assert.fail('Should have thrown content error for empty content');
    } catch (error: any) {
      assert.ok(
        error.message.includes('Content Error') ||
        error.message.includes('empty') ||
        error.name === 'MCPSearXNGError',
      );
    } finally {
      await close();
    }
  }, results);

  await testFunction('Whitespace-only content handling', async () => {
    const mockServer = createMockServer();
    urlCache.clear();
    const { url, close } = await startTestServer({ body: '   \n\t   ' });
    try {
      await fetchAndConvertToMarkdown(mockServer as any, url);
      assert.fail('Should have thrown content error for whitespace-only content');
    } catch (error: any) {
      assert.ok(
        error.message.includes('Content Error') ||
        error.message.includes('empty') ||
        error.name === 'MCPSearXNGError',
      );
    } finally {
      await close();
    }
  }, results);

  // ── gzip decompression (regression test for issue #81) ───────────────────

  await testFunction('Gzip-encoded response is correctly decompressed', async () => {
    const mockServer = createMockServer();
    urlCache.clear();

    const testHtml =
      '<html><body><h1>Gzip Test</h1><p>This content was gzip-compressed.</p></body></html>';
    const gzipped = zlib.gzipSync(Buffer.from(testHtml, 'utf-8'));

    const { url, close } = await startTestServer({
      headers: {
        'content-encoding': 'gzip',
        'content-type': 'text/html; charset=utf-8',
      },
      body: gzipped,
    });
    try {
      const result = await fetchAndConvertToMarkdown(mockServer as any, url);
      assert.ok(typeof result === 'string', 'Result should be a string');
      assert.ok(
        !result.startsWith('\x1f\x8b'),
        'Result must not contain raw gzip bytes',
      );
      assert.ok(
        result.includes('Gzip Test'),
        `Expected "Gzip Test" in result; got: ${result.slice(0, 200)}`,
      );
    } finally {
      await close();
    }
  }, results);

  // ── HTML → Markdown conversion ────────────────────────────────────────────

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
    const { url, close } = await startTestServer({ body: testHtml });
    try {
      const result = await fetchAndConvertToMarkdown(mockServer as any, url);
      assert.ok(typeof result === 'string');
      assert.ok(result.length > 0);
      assert.ok(result.includes('Main Title') || result.includes('#'));
    } finally {
      await close();
    }
  }, results);

  await testFunction('HTML without Content-Type still uses HTML to Markdown conversion', async () => {
    const mockServer = createMockServer();
    urlCache.clear();

    const testHtml = '<html><body><h1>No Type Title</h1><p>This is <strong>HTML</strong>.</p></body></html>';
    const { url, close } = await startHttpServer((req, res) => {
      if (req.method === 'HEAD') {
        res.writeHead(200);
        res.end();
        return;
      }

      res.writeHead(200);
      res.end(testHtml);
    });

    try {
      const result = await fetchAndConvertToMarkdown(mockServer as any, url);
      assert.equal(result, '# No Type Title\n\nThis is **HTML**.');
    } finally {
      await close();
      urlCache.clear();
    }
  }, results);

  await testFunction('Generic non-NUL content still uses HTML to Markdown conversion', async () => {
    const mockServer = createMockServer();
    urlCache.clear();

    const testHtml = '<html><body><h1>Generic Type Title</h1><p>Still HTML.</p></body></html>';
    const { url, close } = await startHttpServer((req, res) => {
      if (req.method === 'HEAD') {
        res.writeHead(200);
        res.end();
        return;
      }

      res.writeHead(200, { 'content-type': 'application/x-custom' });
      res.end(testHtml);
    });

    try {
      const result = await fetchAndConvertToMarkdown(mockServer as any, url);
      assert.equal(result, '# Generic Type Title\n\nStill HTML.');
    } finally {
      await close();
      urlCache.clear();
    }
  }, results);

  await testFunction('XHTML content uses HTML to Markdown conversion', async () => {
    const mockServer = createMockServer();
    urlCache.clear();

    const testHtml = '<html><body><h1>XHTML Title</h1><p>Readable page.</p></body></html>';
    const { url, close } = await startTestServer({
      headers: { 'content-type': 'application/xhtml+xml; charset=utf-8' },
      body: testHtml,
    });

    try {
      const result = await fetchAndConvertToMarkdown(mockServer as any, url);
      assert.equal(result, '# XHTML Title\n\nReadable page.');
    } finally {
      await close();
      urlCache.clear();
    }
  }, results);

  await testFunction('JSON content is pretty-printed in a fenced block', async () => {
    const mockServer = createMockServer();
    urlCache.clear();

    const { url, close } = await startTestServer({
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: '{"name":"searxng","enabled":true,"items":[1,2]}',
    });

    try {
      const result = await fetchAndConvertToMarkdown(mockServer as any, url);
      assert.equal(result, '```json\n{\n  "name": "searxng",\n  "enabled": true,\n  "items": [\n    1,\n    2\n  ]\n}\n```');
    } finally {
      await close();
      urlCache.clear();
    }
  }, results);

  await testFunction('Problem JSON content is pretty-printed in a fenced block', async () => {
    const mockServer = createMockServer();
    urlCache.clear();

    const { url, close } = await startTestServer({
      headers: { 'content-type': 'application/problem+json' },
      body: '{"type":"about:blank","title":"Bad Request","status":400}',
    });

    try {
      const result = await fetchAndConvertToMarkdown(mockServer as any, url);
      assert.equal(result, '```json\n{\n  "type": "about:blank",\n  "title": "Bad Request",\n  "status": 400\n}\n```');
    } finally {
      await close();
      urlCache.clear();
    }
  }, results);

  await testFunction('Invalid JSON content-type returns fenced text with a note', async () => {
    const mockServer = createMockServer();
    urlCache.clear();

    const { url, close } = await startTestServer({
      headers: { 'content-type': 'application/json' },
      body: '{"name":',
    });

    try {
      const result = await fetchAndConvertToMarkdown(mockServer as any, url);
      assert.ok(result.startsWith('Note: Response declared JSON but could not be parsed.'));
      assert.ok(result.includes('```text\n{"name":\n```'), `Expected fenced text, got: ${result}`);
    } finally {
      await close();
      urlCache.clear();
    }
  }, results);

  await testFunction('Readable fenced content uses a longer fence when the body contains backticks', async () => {
    const mockServer = createMockServer();
    urlCache.clear();

    const body = 'before ``` after';
    const { url, close } = await startTestServer({
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      body,
    });

    try {
      const result = await fetchAndConvertToMarkdown(mockServer as any, url);
      assert.ok(result.startsWith('````text\n'), `Expected four-backtick opening fence, got: ${result}`);
      assert.ok(result.endsWith('\n````'), `Expected four-backtick closing fence, got: ${result}`);
      assert.ok(result.includes(body), `Expected original backticks preserved, got: ${result}`);
    } finally {
      await close();
      urlCache.clear();
    }
  }, results);

  await testFunction('Plain text, YAML, TOML, and XML content return fenced readable text', async () => {
    const mockServer = createMockServer();
    urlCache.clear();

    const cases = [
      {
        contentType: 'text/plain; charset=utf-8',
        body: 'plain text\nsecond line',
        expected: '```text\nplain text\nsecond line\n```',
      },
      {
        contentType: 'application/yaml',
        body: 'name: searxng\nenabled: true',
        expected: '```yaml\nname: searxng\nenabled: true\n```',
      },
      {
        contentType: 'application/toml',
        body: 'name = "searxng"\nenabled = true',
        expected: '```toml\nname = "searxng"\nenabled = true\n```',
      },
      {
        contentType: 'application/xml',
        body: '<root><name>searxng</name></root>',
        expected: '```xml\n<root><name>searxng</name></root>\n```',
      },
    ];

    for (const testCase of cases) {
      const { url, close } = await startTestServer({
        headers: { 'content-type': testCase.contentType },
        body: testCase.body,
      });

      try {
        const result = await fetchAndConvertToMarkdown(mockServer as any, url);
        assert.equal(result, testCase.expected);
      } finally {
        await close();
        urlCache.clear();
      }
    }
  }, results);

  await testFunction('Explicit text content with NUL byte in prefix returns binary hint', async () => {
    const mockServer = createMockServer();
    urlCache.clear();

    const { url, close } = await startTestServer({
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      body: Buffer.from([0x74, 0x65, 0x78, 0x74, 0x00, 0x01, 0x02]),
    });

    try {
      const result = await fetchAndConvertToMarkdown(mockServer as any, url);
      assert.ok(result.includes('declared text/plain'), `Expected declared content type in hint, got: ${result}`);
      assert.ok(result.includes('appears binary'), `Expected binary explanation, got: ${result}`);
      assert.ok(!result.includes('```text'), `Expected binary hint, not fenced text, got: ${result}`);
    } finally {
      await close();
      urlCache.clear();
    }
  }, results);

  await testFunction('Explicit binary, archive, image, and video content-types return unsupported hints', async () => {
    const mockServer = createMockServer();
    urlCache.clear();

    const cases = [
      'application/pdf',
      'application/zip',
      'image/png',
      'video/mp4',
      'application/octet-stream',
    ];

    for (const contentType of cases) {
      const { url, close } = await startTestServer({
        headers: { 'content-type': contentType },
        body: Buffer.from([0, 1, 2, 3, 4, 5]),
      });

      try {
        const result = await fetchAndConvertToMarkdown(mockServer as any, url);
        assert.ok(result.includes('Unsupported content type'), `Expected unsupported hint for ${contentType}, got: ${result}`);
        assert.ok(result.includes(contentType), `Expected content type in hint, got: ${result}`);
        assert.ok(!result.includes('\u0000'), `Hint must not include raw binary bytes: ${result}`);
      } finally {
        await close();
        urlCache.clear();
      }
    }
  }, results);

  await testFunction('Explicit binary content-type cancels before full body download', async () => {
    const mockServer = createMockServer();
    urlCache.clear();

    let chunksWritten = 0;
    let responseClosed = false;
    let resolveResponseClosed: () => void = () => {};
    const responseClosedPromise = new Promise<void>((resolve) => {
      resolveResponseClosed = resolve;
    });
    const totalChunks = 100;

    const { url, close } = await startHttpServer((req, res) => {
      if (req.method === 'HEAD') {
        res.writeHead(200);
        res.end();
        return;
      }

      res.writeHead(200, { 'content-type': 'application/pdf' });
      res.on('close', () => {
        responseClosed = true;
        resolveResponseClosed();
      });

      const writeNext = () => {
        if (res.destroyed || chunksWritten >= totalChunks) {
          res.end();
          return;
        }

        chunksWritten++;
        res.write(Buffer.alloc(32, chunksWritten));
        setImmediate(writeNext);
      };

      writeNext();
    });

    try {
      const result = await fetchAndConvertToMarkdown(mockServer as any, url);
      assert.ok(result.includes('Unsupported content type'), `Expected unsupported hint, got: ${result}`);
      await Promise.race([
        responseClosedPromise,
        new Promise<void>((resolve) => setTimeout(resolve, 100)),
      ]);
      assert.ok(responseClosed, 'Expected response stream to be closed');
      assert.ok(chunksWritten < totalChunks, `Expected early cancellation before ${totalChunks} chunks, wrote ${chunksWritten}`);
    } finally {
      await close();
      urlCache.clear();
    }
  }, results);

  await testFunction('Explicit text content with early NUL cancels before full body download', async () => {
    const mockServer = createMockServer();
    urlCache.clear();

    let chunksWritten = 0;
    let responseClosed = false;
    let resolveResponseClosed: () => void = () => {};
    const responseClosedPromise = new Promise<void>((resolve) => {
      resolveResponseClosed = resolve;
    });
    const totalChunks = 100;

    const { url, close } = await startHttpServer((req, res) => {
      if (req.method === 'HEAD') {
        res.writeHead(200);
        res.end();
        return;
      }

      res.writeHead(200, { 'content-type': 'text/plain' });
      res.on('close', () => {
        responseClosed = true;
        resolveResponseClosed();
      });

      const writeNext = () => {
        if (res.destroyed || chunksWritten >= totalChunks) {
          res.end();
          return;
        }

        chunksWritten++;
        const chunk = chunksWritten === 1
          ? Buffer.from([0x74, 0x65, 0x78, 0x74, 0x00])
          : Buffer.alloc(32, chunksWritten);
        res.write(chunk);
        setImmediate(writeNext);
      };

      writeNext();
    });

    try {
      const result = await fetchAndConvertToMarkdown(mockServer as any, url);
      assert.ok(result.includes('declared text/plain'), `Expected declared content type in hint, got: ${result}`);
      assert.ok(result.includes('appears binary'), `Expected binary explanation, got: ${result}`);
      await Promise.race([
        responseClosedPromise,
        new Promise<void>((resolve) => setTimeout(resolve, 100)),
      ]);
      assert.ok(responseClosed, 'Expected response stream to be closed');
      assert.ok(chunksWritten < totalChunks, `Expected early cancellation before ${totalChunks} chunks, wrote ${chunksWritten}`);
    } finally {
      await close();
      urlCache.clear();
    }
  }, results);

  await testFunction('Missing Content-Type with NUL byte in prefix returns unsupported hint', async () => {
    const mockServer = createMockServer();
    urlCache.clear();

    const { url, close } = await startHttpServer((req, res) => {
      if (req.method === 'HEAD') {
        res.writeHead(200);
        res.end();
        return;
      }

      res.writeHead(200);
      res.end(Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0x01, 0x02]));
    });

    try {
      const result = await fetchAndConvertToMarkdown(mockServer as any, url);
      assert.ok(result.includes('Unsupported content type'), `Expected unsupported hint, got: ${result}`);
      assert.ok(result.includes('binary'), `Expected binary explanation, got: ${result}`);
    } finally {
      await close();
      urlCache.clear();
    }
  }, results);

  await testFunction('Successful JSON and text reads are cached', async () => {
    const mockServer = createMockServer();
    urlCache.clear();

    let jsonRequestCount = 0;
    const jsonServer = await startHttpServer((req, res) => {
      jsonRequestCount++;
      if (req.method === 'HEAD') {
        res.writeHead(200);
        res.end();
        return;
      }

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"cached":true}');
    });

    let textRequestCount = 0;
    const textServer = await startHttpServer((req, res) => {
      textRequestCount++;
      if (req.method === 'HEAD') {
        res.writeHead(200);
        res.end();
        return;
      }

      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('cached text');
    });

    try {
      await fetchAndConvertToMarkdown(mockServer as any, jsonServer.url);
      await fetchAndConvertToMarkdown(mockServer as any, jsonServer.url);
      await fetchAndConvertToMarkdown(mockServer as any, textServer.url);
      await fetchAndConvertToMarkdown(mockServer as any, textServer.url);

      assert.equal(jsonRequestCount, 2, 'Second JSON read should use cache');
      assert.equal(textRequestCount, 2, 'Second text read should use cache');
    } finally {
      await jsonServer.close();
      await textServer.close();
      urlCache.clear();
    }
  }, results);

  await testFunction('Binary-rejected URLs are not cached', async () => {
    const mockServer = createMockServer();
    urlCache.clear();

    let requestCount = 0;
    const { url, close } = await startHttpServer((req, res) => {
      requestCount++;
      if (req.method === 'HEAD') {
        res.writeHead(200);
        res.end();
        return;
      }

      res.writeHead(200, { 'content-type': 'application/pdf' });
      res.end(Buffer.from([0, 1, 2, 3]));
    });

    try {
      const first = await fetchAndConvertToMarkdown(mockServer as any, url);
      const second = await fetchAndConvertToMarkdown(mockServer as any, url);

      assert.ok(first.includes('Unsupported content type'));
      assert.ok(second.includes('Unsupported content type'));
      assert.equal(requestCount, 4, 'Second binary-rejected read should re-fetch instead of using cache');
    } finally {
      await close();
      urlCache.clear();
    }
  }, results);

  // ── character pagination ──────────────────────────────────────────────────

  await testFunction('Character pagination - maxLength', async () => {
    const mockServer = createMockServer();
    urlCache.clear();

    const testHtml =
      '<html><body><h1>Test Title</h1><p>This is a long paragraph with lots of content that we can paginate through.</p></body></html>';
    const { url, close } = await startTestServer({ body: testHtml });
    try {
      const result = await fetchAndConvertToMarkdown(mockServer as any, url, 10000, { maxLength: 20 });
      assert.ok(typeof result === 'string');
      assert.ok(result.length <= 20, `Expected length <= 20, got ${result.length}`);
    } finally {
      await close();
    }
  }, results);

  await testFunction('Character pagination - startChar', async () => {
    const mockServer = createMockServer();
    urlCache.clear();

    const testHtml = '<html><body><h1>Test Title</h1><p>Content here.</p></body></html>';
    const { url, close } = await startTestServer({ body: testHtml });
    try {
      const result = await fetchAndConvertToMarkdown(mockServer as any, url, 10000, { startChar: 10 });
      assert.ok(typeof result === 'string');
    } finally {
      await close();
    }
  }, results);

  await testFunction('Character pagination - both startChar and maxLength', async () => {
    const mockServer = createMockServer();
    urlCache.clear();

    const testHtml = '<html><body><p>Content for pagination test.</p></body></html>';
    const { url, close } = await startTestServer({ body: testHtml });
    try {
      const result = await fetchAndConvertToMarkdown(mockServer as any, url, 10000, {
        startChar: 5,
        maxLength: 15,
      });
      assert.ok(typeof result === 'string');
      assert.ok(result.length <= 15, `Expected length <= 15, got ${result.length}`);
    } finally {
      await close();
    }
  }, results);

  // ── cache integration ─────────────────────────────────────────────────────

  await testFunction('Cache integration with pagination', async () => {
    const mockServer = createMockServer();
    urlCache.clear();

    let requestCount = 0;
    const testHtml =
      '<html><body><h1>Cached Content</h1><p>This content should be cached.</p></body></html>';

    // Persistent server — both calls must use the same URL.
    const server = http.createServer((_req, res) => {
      requestCount++;
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(testHtml);
    });
    await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
    const serverUrl = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;

    try {
      const result1 = await fetchAndConvertToMarkdown(mockServer as any, serverUrl, 10000, {
        maxLength: 50,
      });
      assert.equal(requestCount, 2);
      assert.ok(typeof result1 === 'string');

      // Second call with different pagination options must hit the cache.
      const result2 = await fetchAndConvertToMarkdown(mockServer as any, serverUrl, 10000, {
        startChar: 10,
        maxLength: 30,
      });
      assert.equal(requestCount, 2, 'Second call should use the cache, not re-fetch');
      assert.ok(typeof result2 === 'string');
    } finally {
      server.closeAllConnections();
      await new Promise<void>((res) => server.close(() => res()));
      urlCache.clear();
    }
  }, results);

  // ── proxy env: NO_PROXY bypass ────────────────────────────────────────────

  await testFunction('Proxy agent integration', async () => {
    const mockServer = createMockServer();
    urlCache.clear();

    const testHtml = '<html><body><h1>Test with proxy env</h1></body></html>';
    const { url, close } = await startTestServer({ body: testHtml });

    // Point HTTPS_PROXY at a non-existent host, then exempt localhost via NO_PROXY
    // so the request goes directly to our test server.
    envManager.set('HTTPS_PROXY', 'http://proxy.example.com:8080');
    envManager.set('NO_PROXY', '127.0.0.1,localhost');
    try {
      const result = await fetchAndConvertToMarkdown(mockServer as any, url);
      assert.ok(result.includes('Test with proxy env'));
    } finally {
      await close();
      envManager.restore();
    }
  }, results);

  // ── security: hardened mode ───────────────────────────────────────────────

  await testFunction('default mode blocks private URL reads', async () => {
    const mockServer = createMockServer();
    envManager.delete('MCP_HTTP_HARDEN');
    envManager.delete('MCP_HTTP_ALLOW_PRIVATE_URLS');

    const privateUrls = [
      'http://127.0.0.1:1/private',
      'http://localhost:1/private',
      'http://10.0.0.1/private',
    ];

    try {
      for (const privateUrl of privateUrls) {
        try {
          await fetchAndConvertToMarkdown(mockServer as any, privateUrl, 50);
          assert.fail(`Expected private URL to be blocked: ${privateUrl}`);
        } catch (error: any) {
          assert.ok(
            error.message.includes('blocked by security policy'),
            `Expected security policy error for ${privateUrl}, got: ${error.message}`,
          );
        }
      }
    } finally {
      envManager.restore();
    }
  }, results);

  await testFunction('default mode blocks hostnames resolving to private IPv4 ranges', async () => {
    const mockServer = createMockServer();
    envManager.delete('MCP_HTTP_HARDEN');
    envManager.delete('MCP_HTTP_ALLOW_PRIVATE_URLS');
    envManager.delete('HTTP_PROXY');
    envManager.delete('HTTPS_PROXY');
    envManager.delete('http_proxy');
    envManager.delete('https_proxy');
    envManager.delete('URL_READER_HTTP_PROXY');
    envManager.delete('URL_READER_HTTPS_PROXY');
    envManager.delete('url_reader_http_proxy');
    envManager.delete('url_reader_https_proxy');

    const privateCases: MockDnsRecords = {
      'loopback.example': [{ address: '127.0.0.1', family: 4 }],
      'ten.example': [{ address: '10.0.0.5', family: 4 }],
      'lan.example': [{ address: '192.168.1.20', family: 4 }],
      'rfc1918.example': [{ address: '172.16.0.9', family: 4 }],
      'metadata.example': [{ address: '169.254.169.254', family: 4 }],
      'cgnat.example': [{ address: '100.64.0.1', family: 4 }],
    };
    const restoreDns = installDnsLookupMock(privateCases);

    try {
      for (const hostname of Object.keys(privateCases)) {
        try {
          await fetchAndConvertToMarkdown(mockServer as any, `http://${hostname}/private`, 250);
          assert.fail(`Expected hostname resolving to private IP to be blocked: ${hostname}`);
        } catch (error: any) {
          assert.ok(
            error.message.includes('blocked by security policy'),
            `Expected security policy error for ${hostname}, got: ${error.message}`,
          );
        }
      }
    } finally {
      restoreDns();
      envManager.restore();
    }
  }, results);

  await testFunction('default mode blocks hostnames resolving to private IPv6 ranges', async () => {
    const mockServer = createMockServer();
    envManager.delete('MCP_HTTP_HARDEN');
    envManager.delete('MCP_HTTP_ALLOW_PRIVATE_URLS');
    envManager.delete('HTTP_PROXY');
    envManager.delete('HTTPS_PROXY');
    envManager.delete('http_proxy');
    envManager.delete('https_proxy');
    envManager.delete('URL_READER_HTTP_PROXY');
    envManager.delete('URL_READER_HTTPS_PROXY');
    envManager.delete('url_reader_http_proxy');
    envManager.delete('url_reader_https_proxy');

    const privateCases: MockDnsRecords = {
      'v6-loopback.example': [{ address: '::1', family: 6 }],
      'v6-ula.example': [{ address: 'fc00::1', family: 6 }],
      'v6-linklocal.example': [{ address: 'fe80::1', family: 6 }],
    };
    const restoreDns = installDnsLookupMock(privateCases);

    try {
      for (const hostname of Object.keys(privateCases)) {
        try {
          await fetchAndConvertToMarkdown(mockServer as any, `http://${hostname}/private`, 250);
          assert.fail(`Expected hostname resolving to private IPv6 to be blocked: ${hostname}`);
        } catch (error: any) {
          assert.ok(
            error.message.includes('blocked by security policy'),
            `Expected security policy error for ${hostname}, got: ${error.message}`,
          );
        }
      }
    } finally {
      restoreDns();
      envManager.restore();
    }
  }, results);

  await testFunction('default mode allows hostnames resolving only to public addresses and pins the connection', async () => {
    envManager.delete('MCP_HTTP_HARDEN');
    envManager.delete('MCP_HTTP_ALLOW_PRIVATE_URLS');

    let lookupCount = 0;
    const originalLookup = dnsModule.lookup;
    (dnsModule as any).lookup = (hostname: string, options: any, callback?: any) => {
      if (net.isIP(hostname)) {
        return (originalLookup as any).call(dnsModule, hostname, options, callback);
      }

      lookupCount++;
      const cb = typeof options === 'function' ? options : callback;
      if (options?.all) {
        cb(null, [{ address: TEST_PUBLIC_IP, family: 4 }]);
        return;
      }
      cb(null, TEST_PUBLIC_IP, 4);
    };
    syncBuiltinESMExports();
    const lookup = createUrlReaderLookup();

    try {
      const result = await new Promise<{ address: string; family: number }>((resolve, reject) => {
        lookup('public.example', {}, (error, address, family) => {
          if (error) {
            reject(error);
            return;
          }
          resolve({ address: address || '', family: family || 0 });
        });
      });

      assert.deepEqual(result, { address: TEST_PUBLIC_IP, family: 4 });
      const allResult = await new Promise<Array<{ address: string; family: number }>>((resolve, reject) => {
        lookup('public.example', { all: true }, (error, address) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(Array.isArray(address) ? address : []);
        });
      });

      assert.deepEqual(allResult, [{ address: TEST_PUBLIC_IP, family: 4 }]);
      assert.equal(lookupCount, 2, 'Expected one DNS lookup per custom lookup invocation');
    } finally {
      (dnsModule as any).lookup = originalLookup;
      syncBuiltinESMExports();
      envManager.restore();
    }
  }, results);

  await testFunction('default mode blocks rebinding when any DNS answer is private', async () => {
    const mockServer = createMockServer();
    envManager.delete('MCP_HTTP_HARDEN');
    envManager.delete('MCP_HTTP_ALLOW_PRIVATE_URLS');
    envManager.delete('HTTP_PROXY');
    envManager.delete('HTTPS_PROXY');
    envManager.delete('http_proxy');
    envManager.delete('https_proxy');
    envManager.delete('URL_READER_HTTP_PROXY');
    envManager.delete('URL_READER_HTTPS_PROXY');
    envManager.delete('url_reader_http_proxy');
    envManager.delete('url_reader_https_proxy');

    const restoreDns = installDnsLookupMock({
      'mixed.example': [
        { address: TEST_PUBLIC_IP, family: 4 },
        { address: '127.0.0.1', family: 4 },
      ],
    });

    try {
      await fetchAndConvertToMarkdown(mockServer as any, 'http://mixed.example/private', 250);
      assert.fail('Expected hostname with any private DNS answer to be blocked');
    } catch (error: any) {
      assert.ok(
        error.message.includes('blocked by security policy'),
        `Expected security policy error, got: ${error.message}`,
      );
    } finally {
      restoreDns();
      envManager.restore();
    }
  }, results);

  await testFunction('MCP_HTTP_ALLOW_PRIVATE_URLS allows private DNS resolution', async () => {
    const mockServer = createMockServer();
    urlCache.clear();
    envManager.delete('MCP_HTTP_HARDEN');
    envManager.set('MCP_HTTP_ALLOW_PRIVATE_URLS', 'true');
    envManager.delete('HTTP_PROXY');
    envManager.delete('HTTPS_PROXY');
    envManager.delete('http_proxy');
    envManager.delete('https_proxy');
    envManager.delete('URL_READER_HTTP_PROXY');
    envManager.delete('URL_READER_HTTPS_PROXY');
    envManager.delete('url_reader_http_proxy');
    envManager.delete('url_reader_https_proxy');

    const restoreDns = installDnsLookupMock({
      'internal.example': [{ address: '127.0.0.1', family: 4 }],
    });
    const { url, close } = await startTestServer({ body: '<html><body><h1>Internal DNS target</h1></body></html>' });
    const port = new URL(url).port;

    try {
      const result = await fetchAndConvertToMarkdown(mockServer as any, `http://internal.example:${port}/article`, 1000);
      assert.ok(result.includes('Internal DNS target'), `Expected private DNS opt-out fetch, got: ${result}`);
    } finally {
      restoreDns();
      await close();
      envManager.restore();
      urlCache.clear();
    }
  }, results);

  await testFunction('redirect target resolving to a private IP is blocked', async () => {
    envManager.delete('MCP_HTTP_HARDEN');
    envManager.delete('MCP_HTTP_ALLOW_PRIVATE_URLS');

    const restoreDns = installDnsLookupMock({
      'private-redirect.example': [{ address: '127.0.0.1', family: 4 }],
    });
    const lookup = createUrlReaderLookup();

    try {
      await new Promise<void>((resolve, reject) => {
        lookup('private-redirect.example', {}, (error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      assert.fail('Expected redirect target resolving to private IP to be blocked');
    } catch (error: any) {
      assert.ok(
        error.name === 'URLSecurityPolicyDnsError',
        `Expected DNS security policy error, got: ${error.name}: ${error.message}`,
      );
    } finally {
      restoreDns();
      envManager.restore();
    }
  }, results);

  await testFunction('default mode blocks 0.0.0.0 URL reads', async () => {
    const mockServer = createMockServer();
    envManager.delete('MCP_HTTP_HARDEN');
    envManager.delete('MCP_HTTP_ALLOW_PRIVATE_URLS');

    try {
      await fetchAndConvertToMarkdown(mockServer as any, 'http://0.0.0.0:1/private', 50);
      assert.fail('Expected 0.0.0.0 URL to be blocked');
    } catch (error: any) {
      assert.ok(error.message.includes('blocked by security policy'));
    } finally {
      envManager.restore();
    }
  }, results);

  await testFunction('default mode blocks hex IPv4-mapped IPv6 private URL reads', async () => {
    const mockServer = createMockServer();
    envManager.delete('MCP_HTTP_HARDEN');
    envManager.delete('MCP_HTTP_ALLOW_PRIVATE_URLS');

    try {
      await fetchAndConvertToMarkdown(mockServer as any, 'http://[::ffff:7f00:1]:1/private', 50);
      assert.fail('Expected IPv4-mapped IPv6 URL to be blocked');
    } catch (error: any) {
      assert.ok(error.message.includes('blocked by security policy'));
    } finally {
      envManager.restore();
    }
  }, results);

  await testFunction('redirects to private URLs are blocked', async () => {
    const mockServer = createMockServer();
    envManager.delete('MCP_HTTP_HARDEN');
    envManager.delete('MCP_HTTP_ALLOW_PRIVATE_URLS');

    const proxy = await startConnectProxyServer((authority) => {
      if (authority === 'public.example:80') {
        return {
          status: 302,
          headers: { Location: 'http://127.0.0.1:12345/private' },
        };
      }

      return {
        body: '<html><body><h1>Internal redirect target</h1></body></html>',
      };
    });

    envManager.set('URL_READER_HTTP_PROXY', proxy.url);
    envManager.delete('NO_PROXY');
    try {
      await fetchAndConvertToMarkdown(mockServer as any, 'http://public.example/article', 1000);
      assert.fail('Expected redirect to private URL to be blocked');
    } catch (error: any) {
      assert.ok(
        error.message.includes('blocked by security policy'),
        `Expected security policy error, got: ${error.message}`,
      );
    } finally {
      await proxy.close();
      envManager.restore();
    }
  }, results);

  await testFunction('redirects to public URLs are followed', async () => {
    const mockServer = createMockServer();
    urlCache.clear();
    envManager.delete('MCP_HTTP_HARDEN');
    envManager.delete('MCP_HTTP_ALLOW_PRIVATE_URLS');

    const proxy = await startConnectProxyServer((authority, requestText) => {
      if (authority === 'public.example:80' && requestText.startsWith('GET /start ')) {
        return {
          status: 302,
          headers: { Location: 'http://safe.example/final' },
        };
      }

      return {
        body: '<html><body><h1>Public redirect target</h1></body></html>',
      };
    });

    envManager.set('URL_READER_HTTP_PROXY', proxy.url);
    envManager.delete('NO_PROXY');
    try {
      const result = await fetchAndConvertToMarkdown(mockServer as any, 'http://public.example/start', 1000);
      assert.ok(result.includes('Public redirect target'), `Expected public redirect content, got: ${result}`);
    } finally {
      await proxy.close();
      envManager.restore();
    }
  }, results);

  await testFunction('HEAD preflight checks redirected final URL before downloading it', async () => {
    const mockServer = createMockServer();
    urlCache.clear();
    envManager.set('URL_READ_MAX_CONTENT_LENGTH_BYTES', '100');

    const seenRequests: string[] = [];
    const { url, close } = await startHttpServer((req, res) => {
      seenRequests.push(`${req.method} ${req.url}`);
      if (req.url === '/start' && req.method === 'HEAD') {
        res.writeHead(302, { location: '/final' });
        res.end();
        return;
      }
      if (req.url === '/start' && req.method === 'GET') {
        res.writeHead(302, { location: '/final' });
        res.end();
        return;
      }
      if (req.url === '/final' && req.method === 'HEAD') {
        res.writeHead(200, { 'content-length': '101' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><body><h1>Should not download final</h1></body></html>');
    });

    try {
      const result = await fetchAndConvertToMarkdown(mockServer as any, `${url}/start`);
      assert.ok(result.includes('Content too large'));
      assert.deepEqual(seenRequests, ['HEAD /start', 'GET /start', 'HEAD /final']);
    } finally {
      await close();
      envManager.restore();
      urlCache.clear();
    }
  }, results);

  await testFunction('redirect responses without Location are treated as server errors', async () => {
    const mockServer = createMockServer();
    envManager.delete('MCP_HTTP_HARDEN');
    envManager.delete('MCP_HTTP_ALLOW_PRIVATE_URLS');

    const proxy = await startConnectProxyServer(() => ({
      status: 302,
      body: '<html><body>Missing location</body></html>',
    }));

    envManager.set('URL_READER_HTTP_PROXY', proxy.url);
    envManager.delete('NO_PROXY');
    try {
      await fetchAndConvertToMarkdown(mockServer as any, 'http://public.example/missing-location', 1000);
      assert.fail('Expected redirect without Location to be treated as a server error');
    } catch (error: any) {
      assert.ok(error.message.includes('Server Error') || error.message.includes('302'));
    } finally {
      await proxy.close();
      envManager.restore();
    }
  }, results);

  await testFunction('redirect chains are capped', async () => {
    const mockServer = createMockServer();
    envManager.delete('MCP_HTTP_HARDEN');
    envManager.delete('MCP_HTTP_ALLOW_PRIVATE_URLS');

    let redirectCount = 0;
    const proxy = await startConnectProxyServer(() => {
      redirectCount++;
      return {
        status: 302,
        headers: { Location: `http://loop.example/redirect-${redirectCount}` },
      };
    });

    envManager.set('URL_READER_HTTP_PROXY', proxy.url);
    envManager.delete('NO_PROXY');
    try {
      await fetchAndConvertToMarkdown(mockServer as any, 'http://public.example/start-loop', 1000);
      assert.fail('Expected redirect chain to be capped');
    } catch (error: any) {
      assert.ok(error.message.includes('Too many redirects'), `Unexpected error: ${error.message}`);
    } finally {
      await proxy.close();
      envManager.restore();
    }
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
    } finally {
      envManager.restore();
    }
  }, results);

  await testFunction('override allows localhost URL reads in hardened mode', async () => {
    const mockServer = createMockServer();
    urlCache.clear();

    const testHtml = '<html><body><h1>Internal</h1></body></html>';
    const { url, close } = await startTestServer({ body: testHtml });

    envManager.set('MCP_HTTP_HARDEN', 'true');
    envManager.set('MCP_HTTP_ALLOW_PRIVATE_URLS', 'true');
    try {
      const result = await fetchAndConvertToMarkdown(mockServer as any, url);
      assert.ok(result.includes('Internal'));
    } finally {
      await close();
      envManager.restore();
    }
  }, results);

  // ── section extraction ────────────────────────────────────────────────────

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
    const { url, close } = await startTestServer({ body: testHtml });
    try {
      const result = await fetchAndConvertToMarkdown(mockServer as any, url, 10000, {
        section: 'Installation',
      });
      assert.ok(result.includes('Installation'), `Expected "Installation" in: ${result}`);
      assert.ok(!result.includes('Usage'), `Expected "Usage" NOT in section result`);
    } finally {
      await close();
    }
  }, results);

  await testFunction('Section extraction - section not found returns message', async () => {
    const mockServer = createMockServer();
    urlCache.clear();

    const testHtml = '<html><body><h1>Overview</h1><p>Text.</p></body></html>';
    const { url, close } = await startTestServer({ body: testHtml });
    try {
      const result = await fetchAndConvertToMarkdown(mockServer as any, url, 10000, {
        section: 'NonExistentSection',
      });
      assert.ok(result.includes('not found'), `Expected "not found" message, got: ${result}`);
    } finally {
      await close();
    }
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
    const { url, close } = await startTestServer({ body: testHtml });
    try {
      const result = await fetchAndConvertToMarkdown(mockServer as any, url, 10000, {
        section: 'API (v1.0+) reference?',
      });
      assert.ok(
        result.includes('API (v1.0+) reference?'),
        `Expected literal heading match, got: ${result}`,
      );
      assert.ok(
        result.includes('Literal metacharacter heading content'),
        `Expected matching section body, got: ${result}`,
      );
      assert.ok(
        !result.includes('Regex-like near miss'),
        'Expected regex-like near miss to be excluded',
      );
    } finally {
      await close();
    }
  }, results);

  // ── paragraph range ───────────────────────────────────────────────────────

  await testFunction('Paragraph range - single paragraph', async () => {
    const mockServer = createMockServer();
    urlCache.clear();

    const testHtml =
      '<html><body><p>First paragraph.</p><p>Second paragraph.</p><p>Third paragraph.</p></body></html>';
    const { url, close } = await startTestServer({ body: testHtml });
    try {
      const result = await fetchAndConvertToMarkdown(mockServer as any, url, 10000, {
        paragraphRange: '1',
      });
      assert.ok(result.includes('First paragraph'), `Expected first paragraph, got: ${result}`);
      assert.ok(!result.includes('Second paragraph'), `Expected only first paragraph`);
    } finally {
      await close();
    }
  }, results);

  await testFunction('Paragraph range - specific range', async () => {
    const mockServer = createMockServer();
    urlCache.clear();

    const testHtml =
      '<html><body><p>Para one.</p><p>Para two.</p><p>Para three.</p><p>Para four.</p></body></html>';
    const { url, close } = await startTestServer({ body: testHtml });
    try {
      const result = await fetchAndConvertToMarkdown(mockServer as any, url, 10000, {
        paragraphRange: '2-3',
      });
      assert.ok(result.includes('Para two'), `Expected para two, got: ${result}`);
      assert.ok(result.includes('Para three'), `Expected para three, got: ${result}`);
      assert.ok(!result.includes('Para one'), `Expected para one excluded`);
    } finally {
      await close();
    }
  }, results);

  await testFunction('Paragraph range - range to end', async () => {
    const mockServer = createMockServer();
    urlCache.clear();

    const testHtml =
      '<html><body><p>Alpha.</p><p>Beta.</p><p>Gamma.</p></body></html>';
    const { url, close } = await startTestServer({ body: testHtml });
    try {
      const result = await fetchAndConvertToMarkdown(mockServer as any, url, 10000, {
        paragraphRange: '2-',
      });
      assert.ok(result.includes('Beta'), `Expected Beta, got: ${result}`);
      assert.ok(result.includes('Gamma'), `Expected Gamma, got: ${result}`);
      assert.ok(!result.includes('Alpha'), `Expected Alpha excluded`);
    } finally {
      await close();
    }
  }, results);

  await testFunction('Paragraph range - out of bounds returns message', async () => {
    const mockServer = createMockServer();
    urlCache.clear();

    const testHtml = '<html><body><p>Only one paragraph.</p></body></html>';
    const { url, close } = await startTestServer({ body: testHtml });
    try {
      const result = await fetchAndConvertToMarkdown(mockServer as any, url, 10000, {
        paragraphRange: '99',
      });
      assert.ok(
        result.includes('invalid') || result.includes('out of bounds'),
        `Expected out-of-bounds message, got: ${result}`,
      );
    } finally {
      await close();
    }
  }, results);

  // ── readHeadings ──────────────────────────────────────────────────────────

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
    const { url, close } = await startTestServer({ body: testHtml });
    try {
      const result = await fetchAndConvertToMarkdown(mockServer as any, url, 10000, {
        readHeadings: true,
      });
      assert.ok(result.includes('Main Title'), `Expected Main Title, got: ${result}`);
      assert.ok(result.includes('Chapter One'), `Expected Chapter One, got: ${result}`);
      assert.ok(!result.includes('Some paragraph text'), `Paragraph should be excluded`);
    } finally {
      await close();
    }
  }, results);

  await testFunction('readHeadings with no headings returns message', async () => {
    const mockServer = createMockServer();
    urlCache.clear();

    const testHtml = '<html><body><p>Only plain text, no headings here.</p></body></html>';
    const { url, close } = await startTestServer({ body: testHtml });
    try {
      const result = await fetchAndConvertToMarkdown(mockServer as any, url, 10000, {
        readHeadings: true,
      });
      assert.ok(
        result.includes('No headings found'),
        `Expected "No headings found", got: ${result}`,
      );
    } finally {
      await close();
    }
  }, results);

  if (originalAllowPrivateUrls === undefined) {
    delete process.env.MCP_HTTP_ALLOW_PRIVATE_URLS;
  } else {
    process.env.MCP_HTTP_ALLOW_PRIVATE_URLS = originalAllowPrivateUrls;
  }

  printTestSummary(results, 'URL Reader Module');
  return results;
}

// Run if executed directly
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  runTests().then(results => {
    process.exit(results.failed > 0 ? 1 : 0);
  }).catch(console.error);
}

export { runTests };
