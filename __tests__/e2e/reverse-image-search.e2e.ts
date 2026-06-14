#!/usr/bin/env tsx

/**
 * E2E Tests: reverse_image_search tool against live SearXNG instance.
 *
 * Requires: SEARXNG_LIVE_URL env var + built dist/cli.js
 * Run: SEARXNG_LIVE_URL=http://localhost:8080 npx tsx __tests__/e2e/reverse-image-search.e2e.ts
 */

import { strict as assert } from 'node:assert';
import {
  checkSkipConditions,
  INIT_PARAMS,
  spawnWithMessages,
  LIVE_URL,
} from './helpers/spawn-server.js';
import { testFunction, createTestResults, printTestSummary } from '../helpers/test-utils.js';

const results = createTestResults();

// A stable, publicly accessible image URL used across tests
const TEST_IMAGE_URL = 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/47/PNG_transparency_demonstration_1.png/280px-PNG_transparency_demonstration_1.png';

async function runTests() {
  console.log('🖼️  E2E Testing: reverse_image_search (live)\n');

  const skip = checkSkipConditions();
  if (skip) {
    console.log(skip);
    return { passed: 0, failed: 0, errors: [] };
  }

  await testFunction('basic reverse image search returns results', async () => {
    const responses = spawnWithMessages([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: INIT_PARAMS },
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'reverse_image_search',
          arguments: { image_url: TEST_IMAGE_URL },
        },
      },
    ]);

    const r = responses[2];
    assert.ok(r, 'no response to tools/call id=2');
    assert.ok(!r.error, `server returned error: ${JSON.stringify(r.error)}`);

    const text: string = r.result?.content?.[0]?.text ?? '';
    assert.ok(text.length > 0, 'response text should be non-empty');
  }, results);

  await testFunction('text format includes URL and Title fields', async () => {
    const responses = spawnWithMessages([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: INIT_PARAMS },
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'reverse_image_search',
          arguments: { image_url: TEST_IMAGE_URL, response_format: 'text' },
        },
      },
    ]);

    const text: string = responses[2]?.result?.content?.[0]?.text ?? '';
    // Either results or an explicit no-results message
    const hasResults = text.includes('URL:') && text.includes('Title:');
    const hasNoResults = text.includes('No reverse image search results');
    assert.ok(hasResults || hasNoResults, `unexpected response: ${text.slice(0, 200)}`);
  }, results);

  await testFunction('json format returns parseable JSON with image_url at top level', async () => {
    const responses = spawnWithMessages([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: INIT_PARAMS },
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'reverse_image_search',
          arguments: { image_url: TEST_IMAGE_URL, response_format: 'json' },
        },
      },
    ]);

    const text: string = responses[2]?.result?.content?.[0]?.text ?? '';
    const parsed = JSON.parse(text);
    assert.strictEqual(parsed.image_url, TEST_IMAGE_URL, 'image_url should be at top level');
    assert.ok(Array.isArray(parsed.results), 'results should be an array');
  }, results);

  await testFunction('explicit tineye engine is forwarded', async () => {
    const responses = spawnWithMessages([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: INIT_PARAMS },
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'reverse_image_search',
          arguments: { image_url: TEST_IMAGE_URL, engines: 'tineye', response_format: 'json' },
        },
      },
    ]);

    const r = responses[2];
    // If tineye isn't enabled in this instance, we get a validation error — that's also acceptable
    const text: string = r?.result?.content?.[0]?.text ?? '';
    const isError = r?.error || text.includes('Invalid SearXNG engine');
    const isJson = !isError && (() => { try { JSON.parse(text); return true; } catch { return false; } })();
    assert.ok(isError || isJson, `unexpected response: ${text.slice(0, 300)}`);
  }, results);

  await testFunction('invalid image_url (no http) returns clear error', async () => {
    const responses = spawnWithMessages([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: INIT_PARAMS },
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'reverse_image_search',
          arguments: { image_url: 'not-a-url' },
        },
      },
    ]);

    const r = responses[2];
    const hasError = r?.error || r?.result?.content?.[0]?.text?.includes('http');
    assert.ok(hasError, 'should return an error for non-http image URL');
  }, results);

  await testFunction('num_results limits response count', async () => {
    const responses = spawnWithMessages([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: INIT_PARAMS },
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'reverse_image_search',
          arguments: { image_url: TEST_IMAGE_URL, num_results: 2, response_format: 'json' },
        },
      },
    ]);

    const text: string = responses[2]?.result?.content?.[0]?.text ?? '';
    const parsed = JSON.parse(text);
    assert.ok(parsed.results.length <= 2, `expected ≤2 results, got ${parsed.results.length}`);
  }, results);

  return results;
}

runTests().then((r) => {
  if (r && 'passed' in r) printTestSummary(r as any);
}).catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
