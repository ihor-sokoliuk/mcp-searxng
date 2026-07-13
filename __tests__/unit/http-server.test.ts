#!/usr/bin/env tsx

/**
 * Unit Tests: http-server.ts
 *
 * Tests for HTTP server utilities, focusing on resolveBindHost()
 */

import { strict as assert } from 'node:assert';
import { fileURLToPath } from 'node:url';
import { resolveBindHost, parseRateLimitEnv } from '../../src/http-server.js';
import { testFunction, createTestResults, printTestSummary, TestResult } from '../helpers/test-utils.js';
import { EnvManager } from '../helpers/env-utils.js';

const results = createTestResults();
const envManager = new EnvManager();

/** Runs `fn` with `console.warn` captured, returns the captured lines, and always restores console.warn. */
function captureWarnings(fn: () => void): string[] {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...a: unknown[]) => { warnings.push(a.map(String).join(' ')); };
  try {
    fn();
  } finally {
    console.warn = original;
  }
  return warnings;
}

export async function runTests(): Promise<TestResult> {
  console.log('🧪 Testing: http-server.ts\n');

  // --- resolveBindHost() ---

  await testFunction('No MCP_HTTP_HOST env var → defaults to 127.0.0.1', () => {
    envManager.delete('MCP_HTTP_HOST');
    assert.equal(resolveBindHost(undefined), '127.0.0.1');
    envManager.restore();
  }, results);

  await testFunction('MCP_HTTP_HOST=127.0.0.1 → localhost IPv4', () => {
    envManager.set('MCP_HTTP_HOST', '127.0.0.1');
    assert.equal(resolveBindHost(process.env.MCP_HTTP_HOST), '127.0.0.1');
    envManager.restore();
  }, results);

  await testFunction('MCP_HTTP_HOST=::1 → localhost IPv6', () => {
    envManager.set('MCP_HTTP_HOST', '::1');
    assert.equal(resolveBindHost(process.env.MCP_HTTP_HOST), '::1');
    envManager.restore();
  }, results);

  await testFunction('MCP_HTTP_HOST=0.0.0.0 → explicit all-interfaces', () => {
    envManager.set('MCP_HTTP_HOST', '0.0.0.0');
    assert.equal(resolveBindHost(process.env.MCP_HTTP_HOST), '0.0.0.0');
    envManager.restore();
  }, results);

  await testFunction('MCP_HTTP_HOST=192.168.1.10 → custom IP address', () => {
    envManager.set('MCP_HTTP_HOST', '192.168.1.10');
    assert.equal(resolveBindHost(process.env.MCP_HTTP_HOST), '192.168.1.10');
    envManager.restore();
  }, results);

  await testFunction('MCP_HTTP_HOST="" (empty string) → defaults to 127.0.0.1', () => {
    envManager.set('MCP_HTTP_HOST', '');
    assert.equal(resolveBindHost(process.env.MCP_HTTP_HOST), '127.0.0.1');
    envManager.restore();
  }, results);

  await testFunction('MCP_HTTP_HOST="   " (whitespace only) → defaults to 127.0.0.1', () => {
    envManager.set('MCP_HTTP_HOST', '   ');
    assert.equal(resolveBindHost(process.env.MCP_HTTP_HOST), '127.0.0.1');
    envManager.restore();
  }, results);

  await testFunction('Surrounding whitespace is trimmed from valid value', () => {
    assert.equal(resolveBindHost('  127.0.0.1  '), '127.0.0.1');
  }, results);

  // --- parseRateLimitEnv() ---

  await testFunction('parseRateLimitEnv: unset env var → fallback, no warning', () => {
    envManager.delete('MCP_RATE_TEST');
    let result = 0;
    const warnings = captureWarnings(() => { result = parseRateLimitEnv('MCP_RATE_TEST', 20); });
    envManager.restore();
    assert.equal(result, 20);
    assert.equal(warnings.length, 0, 'absent value must not warn');
  }, results);

  await testFunction('parseRateLimitEnv: whitespace-only → fallback, no warning', () => {
    envManager.set('MCP_RATE_TEST', '   ');
    let result = 0;
    const warnings = captureWarnings(() => { result = parseRateLimitEnv('MCP_RATE_TEST', 20); });
    envManager.restore();
    assert.equal(result, 20);
    assert.equal(warnings.length, 0, 'blank value must not warn');
  }, results);

  await testFunction('parseRateLimitEnv: non-numeric → fallback AND warns', () => {
    envManager.set('MCP_RATE_TEST', 'abc'); // no leading digit → parseInt yields NaN (the fail-open case)
    let result = 0;
    const warnings = captureWarnings(() => { result = parseRateLimitEnv('MCP_RATE_TEST', 20); });
    envManager.restore();
    assert.equal(result, 20);
    assert.equal(warnings.length, 1, 'invalid value must warn once');
    assert.ok(warnings[0].includes('MCP_RATE_TEST'), 'warning names the variable');
    assert.ok(warnings[0].includes('20'), 'warning names the default used');
  }, results);

  await testFunction('parseRateLimitEnv: zero and negative → fallback AND warns', () => {
    for (const bad of ['0', '-5']) {
      envManager.set('MCP_RATE_TEST', bad);
      let result = 0;
      const warnings = captureWarnings(() => { result = parseRateLimitEnv('MCP_RATE_TEST', 300); });
      envManager.restore();
      assert.equal(result, 300, `${bad} → fallback`);
      assert.equal(warnings.length, 1, `${bad} must warn`);
    }
  }, results);

  await testFunction('parseRateLimitEnv: valid positive integer is honored, no warning', () => {
    envManager.set('MCP_RATE_TEST', '50');
    let result = 0;
    const warnings = captureWarnings(() => { result = parseRateLimitEnv('MCP_RATE_TEST', 20); });
    envManager.restore();
    assert.equal(result, 50);
    assert.equal(warnings.length, 0, 'valid value must not warn');
  }, results);

  printTestSummary(results, 'HTTP Server');
  return results;
}

// Allow running this file directly
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  runTests().then(r => {
    if (r.failed > 0) process.exit(1);
  });
}
