#!/usr/bin/env tsx

/**
 * E2E Tests: web_url_read tool against a real public URL.
 *
 * Requires: SEARXNG_LIVE_URL env var (used as existence gate) + built dist/cli.js
 * Run: npm run test:e2e
 *
 * What mocks can't prove: real gzip decompression, encoding handling,
 * and HTML-to-markdown conversion on actual server responses.
 */

import { strict as assert } from 'node:assert';
import http from 'node:http';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import {
  checkSkipConditions,
  INIT_PARAMS,
  spawnWithMessages,
  spawnWithMessagesAsync,
  LIVE_URL,
} from './helpers/spawn-server.js';
import { testFunction, createTestResults, printTestSummary } from '../helpers/test-utils.js';
import { createTextPdf } from '../helpers/pdf-fixtures.js';

const results = createTestResults();
const E2E_TIMEOUT_MS = 15_000;
const LOCAL_PDF_FIRST_PAGE = 'Local PDF first page for E2E';
const LOCAL_PDF_SECOND_PAGE = 'Local PDF second page for E2E';

interface TestServer {
  url: string;
  close: () => Promise<void>;
}

function startPdfServer(pdf: Uint8Array): Promise<TestServer> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((_, response) => {
      response.writeHead(200, {
        'content-type': 'application/pdf',
        'content-length': String(pdf.byteLength),
      });
      response.end(Buffer.from(pdf));
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as net.AddressInfo;
      resolve({
        url: `http://127.0.0.1:${address.port}/fixture.pdf`,
        close: () => new Promise<void>((done, rejectClose) => {
          server.closeAllConnections();
          server.close((error) => error ? rejectClose(error) : done());
        }),
      });
    });
    server.once('error', reject);
  });
}

function readUrlMessages(url: string): object[] {
  return [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: INIT_PARAMS },
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'web_url_read',
        arguments: { url },
      },
    },
  ];
}

async function withinTestBoundary<T>(operation: Promise<T>): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Local PDF E2E test timed out after ${E2E_TIMEOUT_MS}ms`)),
          E2E_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function runTests() {
  console.log('🌐 E2E Testing: web_url_read (live)\n');

  await testFunction('web_url_read reads a two-page local PDF only with the private URL override', async () => {
    await withinTestBoundary((async () => {
      const server = await startPdfServer(createTextPdf([
        LOCAL_PDF_FIRST_PAGE,
        LOCAL_PDF_SECOND_PAGE,
      ]));
      try {
        const blockedResponses = await spawnWithMessagesAsync(
          readUrlMessages(server.url),
          'https://test-searx.example.com',
          E2E_TIMEOUT_MS,
        );
        const blockedResponse = blockedResponses[2];
        assert.ok(
          blockedResponse?.result?.isError || blockedResponse?.error,
          'loopback PDF request should be blocked by the SSRF boundary',
        );
        assert.match(
          String(blockedResponse.result?.content?.[0]?.text ?? blockedResponse.error?.message ?? ''),
          /URL blocked by security policy/i,
          JSON.stringify(blockedResponse),
        );

        const allowedResponses = await spawnWithMessagesAsync(
          readUrlMessages(server.url),
          'https://test-searx.example.com',
          E2E_TIMEOUT_MS,
          { MCP_HTTP_ALLOW_PRIVATE_URLS: 'true' },
        );
        const allowedResponse = allowedResponses[2];
        assert.ok(allowedResponse && !allowedResponse.result?.isError, JSON.stringify(allowedResponse));
        const text: string = allowedResponse.result?.content?.[0]?.text ?? '';
        assert.ok(text.includes(LOCAL_PDF_FIRST_PAGE), text);
        assert.ok(text.includes(LOCAL_PDF_SECOND_PAGE), text);
      } finally {
        await server.close();
      }
    })());
  }, results);

  const liveSkip = checkSkipConditions();
  if (liveSkip) {
    console.log(liveSkip);
    printTestSummary(results, 'E2E: URL Reader');
    return results;
  }

  await testFunction('web_url_read fetches example.com and returns markdown', async () => {
    const responses = spawnWithMessages(
      [
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: INIT_PARAMS },
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: 'web_url_read',
            arguments: { url: 'https://example.com' },
          },
        },
      ],
      LIVE_URL  // SEARXNG_URL is irrelevant here but required by the server
    );

    const r = responses[2];
    assert.ok(r, 'no response to tools/call id=2');
    assert.ok(!r.error, `server error: ${JSON.stringify(r.error)}`);

    const text: string = r.result?.content?.[0]?.text ?? '';
    assert.ok(text.length > 0, 'url-reader returned empty content');
    // example.com reliably has an h1 heading
    assert.ok(
      text.toLowerCase().includes('example'),
      'expected "example" in the converted markdown'
    );
  }, results);

  await testFunction('web_url_read with maxLength=100 returns at most ~100 chars', async () => {
    const responses = spawnWithMessages(
      [
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: INIT_PARAMS },
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: 'web_url_read',
            arguments: { url: 'https://example.com', maxLength: 100 },
          },
        },
      ],
      LIVE_URL
    );

    const r = responses[2];
    assert.ok(r && !r.error, `server error: ${JSON.stringify(r?.error)}`);
    const text: string = r.result?.content?.[0]?.text ?? '';
    // Allow a small buffer for trailing whitespace/newlines
    assert.ok(text.length <= 120, `expected ≤120 chars with maxLength=100, got ${text.length}`);
  }, results);

  await testFunction('web_url_read with readHeadings=true returns heading list', async () => {
    const responses = spawnWithMessages(
      [
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: INIT_PARAMS },
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: 'web_url_read',
            arguments: { url: 'https://example.com', readHeadings: true },
          },
        },
      ],
      LIVE_URL
    );

    const r = responses[2];
    assert.ok(r && !r.error, `server error: ${JSON.stringify(r?.error)}`);
    const text: string = r.result?.content?.[0]?.text ?? '';
    assert.ok(text.length > 0, 'readHeadings returned empty content');
  }, results);

  printTestSummary(results, 'E2E: URL Reader');
  return results;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  runTests().then((r) => process.exit(r.failed > 0 ? 1 : 0)).catch(console.error);
}

export { runTests };
