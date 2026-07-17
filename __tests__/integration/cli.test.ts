#!/usr/bin/env tsx

/**
 * Integration Tests: cli.ts
 *
 * Tests the main().catch() handler in src/cli.ts (lines 15-17).
 * Subprocess approach: spawn tsx with env that makes createHttpServer throw.
 *
 * Known gaps (not tested — require internal process injection):
 *   - lines 5-7:  uncaughtException handler
 *   - lines 10-13: unhandledRejection handler
 */

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { testFunction, createTestResults, printTestSummary } from '../helpers/test-utils.js';

const results = createTestResults();

async function runTests() {
  console.log('🧪 Integration Testing: cli.ts\n');

  await testFunction('main().catch logs error and exits 1 when server creation fails', () => {
    // MCP_HTTP_HARDEN=true without MCP_HTTP_AUTH_TOKEN causes validateHttpSecurityConfig
    // to throw inside createHttpServer, which propagates through main() to the .catch handler.
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'src/cli.ts'],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          MCP_HTTP_PORT: '18099',
          MCP_HTTP_HARDEN: 'true',
          // intentionally omit MCP_HTTP_AUTH_TOKEN to trigger the throw
          MCP_HTTP_AUTH_TOKEN: '',
          SEARXNG_URL: 'https://test-searx.example.com',
        },
        encoding: 'utf8',
        timeout: 8000,
      }
    );

    assert.equal(result.status, 1, `expected exit code 1, got ${result.status}`);
    assert.ok(
      result.stderr.includes('Failed to start server:'),
      `expected "Failed to start server:" in stderr, got:\n${result.stderr}`
    );
    assert.ok(
      result.stderr.includes('MCP_HTTP_AUTH_TOKEN'),
      `expected auth token error in stderr, got:\n${result.stderr}`
    );
  }, results);

  printTestSummary(results, 'CLI');
  return results;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  runTests().then((r) => process.exit(r.failed > 0 ? 1 : 0)).catch(console.error);
}

export { runTests };
