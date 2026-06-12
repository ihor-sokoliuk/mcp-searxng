#!/usr/bin/env tsx

/**
 * E2E Tests: searxng_search_suggestions tool against live SearXNG instance.
 *
 * Requires: SEARXNG_LIVE_URL env var + built dist/cli.js
 * Run: npm run test:e2e
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
  console.log('🌐 E2E Testing: searxng_search_suggestions (live)\n');

  const skip = checkSkipConditions();
  if (skip) {
    console.log(skip);
    return { passed: 0, failed: 0, errors: [] };
  }

  await testFunction('suggestions returns parseable JSON array', async () => {
    const responses = spawnWithMessages([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: INIT_PARAMS },
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'searxng_search_suggestions',
          arguments: { query: 'type' },
        },
      },
    ]);

    const r = responses[2];
    assert.ok(r, 'no response to tools/call id=2');
    assert.ok(!r.error, `server returned error: ${JSON.stringify(r.error)}`);

    const text: string = r.result?.content?.[0]?.text ?? '';
    const payload = JSON.parse(text);
    assert.equal(payload.query, 'type');
    assert.ok(Array.isArray(payload.suggestions), 'suggestions should be an array');
  }, results);

  printTestSummary(results, 'E2E: Search Suggestions');
  return results;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  runTests().then((r) => process.exit(r.failed > 0 ? 1 : 0)).catch(console.error);
}

export { runTests };
