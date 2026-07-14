#!/usr/bin/env tsx

import { strict as assert } from 'node:assert';
import { fileURLToPath } from 'node:url';
import {
  getHttpSecurityConfig,
  validateHttpSecurityConfig,
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
    envManager.delete('MCP_HTTP_TRUST_PROXY');

    const config = getHttpSecurityConfig();
    assert.equal(config.harden, false);
    assert.equal(config.requireAuth, false);
    assert.equal(config.restrictOrigins, false);
    assert.equal(config.trustProxy, false);

    envManager.restore();
  }, results);

  await testFunction('MCP_HTTP_TRUST_PROXY=false keeps trust proxy disabled', () => {
    envManager.set('MCP_HTTP_TRUST_PROXY', 'false');

    const config = getHttpSecurityConfig();
    assert.equal(config.trustProxy, false);

    envManager.restore();
  }, results);

  await testFunction('MCP_HTTP_TRUST_PROXY=0 disables trust proxy (not a bogus subnet)', () => {
    envManager.set('MCP_HTTP_TRUST_PROXY', '0');

    const config = getHttpSecurityConfig();
    assert.equal(config.trustProxy, false);

    envManager.restore();
  }, results);

  await testFunction('MCP_HTTP_TRUST_PROXY=true enables boolean trust proxy', () => {
    envManager.set('MCP_HTTP_TRUST_PROXY', 'true');

    const config = getHttpSecurityConfig();
    assert.equal(config.trustProxy, true);

    envManager.restore();
  }, results);

  await testFunction('MCP_HTTP_TRUST_PROXY=1 enables single-hop trust proxy', () => {
    envManager.set('MCP_HTTP_TRUST_PROXY', '1');

    const config = getHttpSecurityConfig();
    assert.equal(config.trustProxy, 1);

    envManager.restore();
  }, results);

  await testFunction('MCP_HTTP_TRUST_PROXY subnet value passes through unchanged', () => {
    envManager.set('MCP_HTTP_TRUST_PROXY', '10.0.0.0/8');

    const config = getHttpSecurityConfig();
    assert.equal(config.trustProxy, '10.0.0.0/8');

    envManager.restore();
  }, results);

  await testFunction('MCP_HTTP_TRUST_PROXY trims surrounding whitespace', () => {
    envManager.set('MCP_HTTP_TRUST_PROXY', '  loopback  ');

    const config = getHttpSecurityConfig();
    assert.equal(config.trustProxy, 'loopback');

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

  await testFunction('default allowed-hosts includes loopback hosts and their port variants', () => {
    envManager.delete('MCP_HTTP_ALLOWED_HOSTS');

    const config = getHttpSecurityConfig(3000);
    assert.deepEqual(config.allowedHosts, [
      '127.0.0.1',
      'localhost',
      '[::1]',
      '127.0.0.1:3000',
      'localhost:3000',
      '[::1]:3000',
    ]);

    envManager.restore();
  }, results);

  await testFunction('default allowed-hosts without a port omits the port variants', () => {
    envManager.delete('MCP_HTTP_ALLOWED_HOSTS');

    const config = getHttpSecurityConfig();
    assert.deepEqual(config.allowedHosts, ['127.0.0.1', 'localhost', '[::1]']);

    envManager.restore();
  }, results);

  await testFunction('explicit MCP_HTTP_ALLOWED_HOSTS overrides the port-aware default exactly', () => {
    envManager.set('MCP_HTTP_ALLOWED_HOSTS', 'app.example.com:8443, other.example.com');

    const config = getHttpSecurityConfig(3000);
    assert.deepEqual(config.allowedHosts, ['app.example.com:8443', 'other.example.com']);

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

  await testFunction('validateHttpSecurityConfig throws when harden=true but no auth token', () => {
    const config = {
      harden: true,
      requireAuth: true,
      authToken: undefined,
      restrictOrigins: true,
      allowedOrigins: ['https://app.example.com'],
      enableDnsRebindingProtection: true,
      allowedHosts: ['localhost'],
      exposeFullConfig: false,
      allowPrivateUrls: false,
    };
    assert.throws(
      () => validateHttpSecurityConfig(config),
      /MCP_HTTP_AUTH_TOKEN/
    );
  }, results);

  await testFunction('validateHttpSecurityConfig throws when harden=true but no allowed origins', () => {
    const config = {
      harden: true,
      requireAuth: true,
      authToken: 'secret',
      restrictOrigins: true,
      allowedOrigins: [],
      enableDnsRebindingProtection: true,
      allowedHosts: ['localhost'],
      exposeFullConfig: false,
      allowPrivateUrls: false,
    };
    assert.throws(
      () => validateHttpSecurityConfig(config),
      /MCP_HTTP_ALLOWED_ORIGINS/
    );
  }, results);

  await testFunction('isOriginAllowed returns true when restrictOrigins=true but no origin header', () => {
    const config = {
      harden: true,
      restrictOrigins: true,
      allowedOrigins: ['https://app.example.com'],
    } as any;
    assert.equal(isOriginAllowed(undefined, config), true);
  }, results);

  printTestSummary(results, 'HTTP Security');
  return results;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  runTests().then(results => {
    process.exit(results.failed > 0 ? 1 : 0);
  }).catch(console.error);
}

export { runTests };
