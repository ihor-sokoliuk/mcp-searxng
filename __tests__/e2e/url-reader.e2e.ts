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
import { fileURLToPath } from 'node:url';
import {
  checkSkipConditions,
  INIT_PARAMS,
  spawnWithMessages,
  LIVE_URL,
} from './helpers/spawn-server.js';
import { testFunction, createTestResults, printTestSummary } from '../helpers/test-utils.js';

const results = createTestResults();

async function runTests() {
  console.log('🌐 E2E Testing: web_url_read (live)\n');

  const skip = checkSkipConditions();
  if (skip) {
    console.log(skip);
    return { passed: 0, failed: 0, errors: [] };
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
