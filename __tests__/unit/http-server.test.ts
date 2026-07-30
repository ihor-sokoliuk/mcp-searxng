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
import {
  initializeDiagnosticSanitizer,
  resetDiagnosticSanitizerForTests,
} from '../../src/diagnostic-sanitizer.js';

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

  await testFunction('parseRateLimitEnv: malformed or unsafe values → fallback AND one raw-value-free warning', () => {
    const expectedWarning =
      '⚠️  Ignoring invalid MCP_RATE_TEST. Expected a positive integer. Using default 300.';
    for (const bad of [
      '12.5',
      '50ms',
      '1e3',
      '0x10',
      'abc',
      '9007199254740992',
      '0',
      '-5',
    ]) {
      envManager.set('MCP_RATE_TEST', bad);
      let result = 0;
      const warnings = captureWarnings(() => { result = parseRateLimitEnv('MCP_RATE_TEST', 300); });
      envManager.restore();
      assert.equal(result, 300, `${bad} → fallback`);
      assert.equal(warnings.length, 1, `${bad} must warn`);
      assert.equal(warnings[0], expectedWarning, `${bad} must not be copied into diagnostics`);
    }
  }, results);

  await testFunction('parseRateLimitEnv warnings never emit configured invalid values', () => {
    envManager.set('MCP_RATE_TEST', 'rate-secret');
    envManager.set('AUTH_USERNAME', 'rate-user');
    envManager.set('AUTH_PASSWORD', 'rate-secret');
    resetDiagnosticSanitizerForTests();
    initializeDiagnosticSanitizer();

    let result = 0;
    const warnings = captureWarnings(() => {
      result = parseRateLimitEnv('MCP_RATE_TEST', 20);
    });

    assert.equal(result, 20);
    assert.equal(warnings.length, 1);
    assert.ok(!warnings[0].includes('rate-secret'), warnings[0]);
    assert.equal(
      warnings[0],
      '⚠️  Ignoring invalid MCP_RATE_TEST. Expected a positive integer. Using default 20.',
    );
    resetDiagnosticSanitizerForTests();
    envManager.restore();
  }, results);

  await testFunction('parseRateLimitEnv: strict positive integer forms are honored without warnings', () => {
    for (const [raw, expected] of [
      ['50', 50],
      ['+5', 5],
      ['005', 5],
      ['\u00a05\u00a0', 5],
    ] as const) {
      envManager.set('MCP_RATE_TEST', raw);
      let result = 0;
      const warnings = captureWarnings(() => { result = parseRateLimitEnv('MCP_RATE_TEST', 20); });
      envManager.restore();
      assert.equal(result, expected, `${JSON.stringify(raw)} parses strictly`);
      assert.equal(warnings.length, 0, `${JSON.stringify(raw)} must not warn`);
    }
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
