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
import { packageVersion } from '../../src/version.js';

const results = createTestResults();

async function runTests() {
  console.log('🧪 Integration Testing: cli.ts\n');

  await testFunction('source CLI version flags print the package version without starting MCP', () => {
    for (const flag of ['--version', '-v']) {
      const env = { ...process.env };
      delete env.SEARXNG_URL;
      delete env.MCP_HTTP_PORT;
      const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', flag], {
        cwd: process.cwd(),
        env,
        encoding: 'utf8',
        timeout: 8000,
      });

      assert.equal(result.status, 0, `${flag} failed: ${result.stderr}`);
      assert.equal(result.stdout, `${packageVersion}\n`);
      assert.equal(result.stderr, '');
    }
  }, results);

  await testFunction('source CLI help flags print shared configuration guidance without starting MCP', () => {
    for (const flag of ['--help', '-h']) {
      const env = { ...process.env };
      delete env.SEARXNG_URL;
      delete env.MCP_HTTP_PORT;
      const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', flag], {
        cwd: process.cwd(),
        env,
        encoding: 'utf8',
        timeout: 8000,
      });

      assert.equal(result.status, 0, `${flag} failed: ${result.stderr}`);
      assert.equal(result.stderr, '');
      assert.ok(result.stdout.includes('--help, -h'));
      assert.ok(result.stdout.includes('--version, -v'));
      assert.ok(result.stdout.includes('SEARXNG_URL is the only required environment variable'));
      assert.ok(result.stdout.includes('STDIO is the default transport'));
      assert.ok(result.stdout.includes('MCP_HTTP_PORT enables HTTP transport'));
      assert.ok(result.stdout.includes('CONFIGURATION.md'));
      assert.ok(!result.stdout.endsWith('\n\n'), 'help output should end with one newline');
    }
  }, results);

  await testFunction('built npm CLI target handles all metadata flags without starting MCP', () => {
    const build = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc'], {
      cwd: process.cwd(),
      env: process.env,
      encoding: 'utf8',
      timeout: 30000,
    });
    assert.equal(build.status, 0, `build failed:\n${build.stdout}\n${build.stderr}`);

    const env = { ...process.env };
    delete env.SEARXNG_URL;
    delete env.MCP_HTTP_PORT;

    for (const flag of ['--version', '-v']) {
      const result = spawnSync(process.execPath, ['dist/cli.js', flag], {
        cwd: process.cwd(),
        env,
        encoding: 'utf8',
        timeout: 8000,
      });
      assert.equal(result.status, 0, `${flag} failed: ${result.stderr}`);
      assert.equal(result.stdout, `${packageVersion}\n`);
      assert.equal(result.stderr, '');
    }

    for (const flag of ['--help', '-h']) {
      const result = spawnSync(process.execPath, ['dist/cli.js', flag], {
        cwd: process.cwd(),
        env,
        encoding: 'utf8',
        timeout: 8000,
      });
      assert.equal(result.status, 0, `${flag} failed: ${result.stderr}`);
      assert.equal(result.stderr, '');
      assert.ok(result.stdout.includes('--help, -h'));
      assert.ok(result.stdout.includes('--version, -v'));
      assert.ok(result.stdout.includes('SEARXNG_URL is the only required environment variable'));
      assert.ok(result.stdout.includes('CONFIGURATION.md'));
      assert.ok(!result.stdout.endsWith('\n\n'), 'help output should end with one newline');
    }
  }, results);

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

  await testFunction('MCP_HTTP_PORT rejects a numeric prefix with a suffix', () => {
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'src/cli.ts'],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          MCP_HTTP_PORT: '3000x',
          SEARXNG_URL: 'https://test-searx.example.com',
        },
        encoding: 'utf8',
        timeout: 8000,
      }
    );

    assert.equal(result.status, 1, `expected exit code 1, got ${result.status}; stderr:\n${result.stderr}`);
    assert.ok(
      result.stderr.includes('Invalid HTTP port: 3000x'),
      `expected invalid-port diagnostic in stderr, got:\n${result.stderr}`
    );
  }, results);

  printTestSummary(results, 'CLI');
  return results;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  runTests().then((r) => process.exit(r.failed > 0 ? 1 : 0)).catch(console.error);
}

export { runTests };
