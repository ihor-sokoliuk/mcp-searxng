#!/usr/bin/env tsx

/**
 * Unit Tests: http-server.ts
 *
 * Tests for HTTP server utilities, focusing on resolveBindHost()
 */

import { strict as assert } from 'node:assert';
import { resolveBindHost } from '../../src/http-server.js';
import { testFunction, createTestResults, printTestSummary, TestResult } from '../helpers/test-utils.js';
import { EnvManager } from '../helpers/env-utils.js';

const results = createTestResults();
const envManager = new EnvManager();

export async function runTests(): Promise<TestResult> {
  console.log('🧪 Testing: http-server.ts\n');

  // --- resolveBindHost() ---

  await testFunction('No MCP_HTTP_HOST env var → defaults to 0.0.0.0', () => {
    envManager.delete('MCP_HTTP_HOST');
    assert.equal(resolveBindHost(undefined), '0.0.0.0');
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

  await testFunction('MCP_HTTP_HOST="" (empty string) → defaults to 0.0.0.0', () => {
    envManager.set('MCP_HTTP_HOST', '');
    assert.equal(resolveBindHost(process.env.MCP_HTTP_HOST), '0.0.0.0');
    envManager.restore();
  }, results);

  await testFunction('MCP_HTTP_HOST="   " (whitespace only) → defaults to 0.0.0.0', () => {
    envManager.set('MCP_HTTP_HOST', '   ');
    assert.equal(resolveBindHost(process.env.MCP_HTTP_HOST), '0.0.0.0');
    envManager.restore();
  }, results);

  await testFunction('Surrounding whitespace is trimmed from valid value', () => {
    assert.equal(resolveBindHost('  127.0.0.1  '), '127.0.0.1');
  }, results);

  printTestSummary(results, 'HTTP Server');
  return results;
}

// Allow running this file directly
const isMain = process.argv[1]?.endsWith('http-server.test.ts') ||
               process.argv[1]?.endsWith('http-server.test.js');
if (isMain) {
  runTests().then(r => {
    if (r.failed > 0) process.exit(1);
  });
}
