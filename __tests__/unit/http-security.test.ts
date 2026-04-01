#!/usr/bin/env tsx

import { strict as assert } from 'node:assert';
import {
  getHttpSecurityConfig,
  isRequestAuthorized,
  isOriginAllowed,
} from '../../src/http-security.js';
import { testFunction, createTestResults, printTestSummary } from '../helpers/test-utils.js';
import { EnvManager } from '../helpers/env-utils.js';

const results = createTestResults();
const envManager = new EnvManager();

async function runTests() {
  console.log('🧪 Testing: http-security.ts\n');

  await testFunction('default config preserves compatibility mode', () => {
    envManager.delete('MCP_HTTP_HARDEN');
    envManager.delete('MCP_HTTP_AUTH_TOKEN');
    envManager.delete('MCP_HTTP_ALLOWED_ORIGINS');

    const config = getHttpSecurityConfig();
    assert.equal(config.harden, false);
    assert.equal(config.requireAuth, false);
    assert.equal(config.restrictOrigins, false);

    envManager.restore();
  }, results);

  await testFunction('hardened mode requires token and restricted origins', () => {
    envManager.set('MCP_HTTP_HARDEN', 'true');
    envManager.set('MCP_HTTP_AUTH_TOKEN', 'secret-token');
    envManager.set('MCP_HTTP_ALLOWED_ORIGINS', 'https://app.example.com,https://admin.example.com');

    const config = getHttpSecurityConfig();
    assert.equal(config.harden, true);
    assert.equal(config.requireAuth, true);
    assert.deepEqual(config.allowedOrigins, [
      'https://app.example.com',
      'https://admin.example.com',
    ]);

    envManager.restore();
  }, results);

  await testFunction('authorization passes in compatibility mode', () => {
    const config = { harden: false, requireAuth: false } as any;
    assert.equal(isRequestAuthorized(undefined, config), true);
  }, results);

  await testFunction('authorization rejects missing token in hardened mode', () => {
    const config = { harden: true, requireAuth: true, authToken: 'secret-token' } as any;
    assert.equal(isRequestAuthorized(undefined, config), false);
  }, results);

  await testFunction('origin allowlist rejects unknown origins in hardened mode', () => {
    const config = {
      harden: true,
      restrictOrigins: true,
      allowedOrigins: ['https://app.example.com'],
    } as any;
    assert.equal(isOriginAllowed('https://evil.example.com', config), false);
    assert.equal(isOriginAllowed('https://app.example.com', config), true);
  }, results);

  printTestSummary(results, 'HTTP Security');
  return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runTests().then(results => {
    process.exit(results.failed > 0 ? 1 : 0);
  }).catch(console.error);
}

export { runTests };
