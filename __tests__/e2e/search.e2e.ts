#!/usr/bin/env tsx

/**
 * E2E Tests: searxng_web_search tool against live SearXNG instance.
 *
 * Requires: SEARXNG_LIVE_URL env var + built dist/cli.js
 * Run: npm run test:e2e
 *
 * What mocks can't prove: real SearXNG connectivity, actual response format,
 * result scoring, and optional parameter handling end-to-end.
 */

import { strict as assert } from 'node:assert';
import { fileURLToPath } from 'node:url';
import {
  checkSkipConditions,
  INIT_PARAMS,
  spawnWithMessages,
} from './helpers/spawn-server.js';
import { testFunction, createTestResults, printTestSummary } from '../helpers/test-utils.js';

const results = createTestResults();

async function runTests() {
  console.log('🌐 E2E Testing: searxng_web_search (live)\n');

  const skip = checkSkipConditions();
  if (skip) {
    console.log(skip);
    return { passed: 0, failed: 0, errors: [] };
  }

  await testFunction('basic search returns results with title and URL', async () => {
    const responses = spawnWithMessages([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: INIT_PARAMS },
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'searxng_web_search',
          arguments: { query: 'test' },
        },
      },
    ]);

    const r = responses[2];
    assert.ok(r, 'no response to tools/call id=2');
    assert.ok(!r.error, `server returned error: ${JSON.stringify(r.error)}`);

    const text: string = r.result?.content?.[0]?.text ?? '';
    assert.ok(text.length > 0, 'response text should be non-empty');
    // The formatted output always includes a URL line
    assert.ok(text.includes('URL:'), 'response should contain URL: field');
    assert.ok(text.includes('Title:'), 'response should contain Title: field');
    assert.ok(
      !text.includes('undefined'),
      'response should not contain undefined metadata placeholders'
    );
  }, results);

  await testFunction('search with time_range=day returns results', async () => {
    const responses = spawnWithMessages([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: INIT_PARAMS },
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'searxng_web_search',
          arguments: { query: 'test', time_range: 'day' },
        },
      },
    ]);

    const r = responses[2];
    assert.ok(r && !r.error, `server error: ${JSON.stringify(r?.error)}`);
    const text: string = r.result?.content?.[0]?.text ?? '';
    assert.ok(text.length > 0, 'time-filtered search returned empty response');
  }, results);

  await testFunction('search with language=en returns results', async () => {
    const responses = spawnWithMessages([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: INIT_PARAMS },
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'searxng_web_search',
          arguments: { query: 'test', language: 'en' },
        },
      },
    ]);

    const r = responses[2];
    assert.ok(r && !r.error, `server error: ${JSON.stringify(r?.error)}`);
    const text: string = r.result?.content?.[0]?.text ?? '';
    assert.ok(text.length > 0, 'language-filtered search returned empty response');
  }, results);

  printTestSummary(results, 'E2E: Web Search');
  return results;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  runTests().then((r) => process.exit(r.failed > 0 ? 1 : 0)).catch(console.error);
}

export { runTests };
