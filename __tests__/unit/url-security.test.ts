#!/usr/bin/env tsx

import { strict as assert } from 'node:assert';
import { fileURLToPath } from 'node:url';
import {
  assertUrlAllowed,
  isPrivateIPv6,
  isPrivateIpv4,
} from '../../src/url-security.js';
import { testFunction, createTestResults, printTestSummary } from '../helpers/test-utils.js';
import { EnvManager } from '../helpers/env-utils.js';

const results = createTestResults();
const envManager = new EnvManager();

async function runTests() {
  console.log('🧪 Testing: url-security.ts\n');

  await testFunction('isPrivateIpv4 blocks CGNAT boundaries', () => {
    assert.equal(isPrivateIpv4('100.64.0.1'), true);
    assert.equal(isPrivateIpv4('100.127.255.255'), true);
    assert.equal(isPrivateIpv4('100.63.255.255'), false);
    assert.equal(isPrivateIpv4('100.128.0.0'), false);
  }, results);

  await testFunction('isPrivateIpv4 blocks benchmarking boundaries', () => {
    assert.equal(isPrivateIpv4('198.18.0.1'), true);
    assert.equal(isPrivateIpv4('198.19.255.255'), true);
    assert.equal(isPrivateIpv4('198.20.0.0'), false);
  }, results);

  await testFunction('isPrivateIpv4 blocks multicast and reserved ranges', () => {
    assert.equal(isPrivateIpv4('224.0.0.1'), true);
    assert.equal(isPrivateIpv4('239.255.255.255'), true);
    assert.equal(isPrivateIpv4('240.0.0.1'), true);
    assert.equal(isPrivateIpv4('255.255.255.255'), true);
  }, results);

  await testFunction('isPrivateIpv4 blocks IANA special-purpose documentation ranges', () => {
    assert.equal(isPrivateIpv4('192.0.0.1'), true);
    assert.equal(isPrivateIpv4('192.0.2.5'), true);
    assert.equal(isPrivateIpv4('198.51.100.5'), true);
    assert.equal(isPrivateIpv4('203.0.113.5'), true);
  }, results);

  await testFunction('isPrivateIpv4 allows public control addresses', () => {
    assert.equal(isPrivateIpv4('8.8.8.8'), false);
    assert.equal(isPrivateIpv4('1.1.1.1'), false);
    assert.equal(isPrivateIpv4('100.128.0.5'), false);
  }, results);

  await testFunction('isPrivateIpv4 blocks RFC1918, loopback, link-local, and unspecified ranges', () => {
    // unspecified 0.0.0.0/8
    assert.equal(isPrivateIpv4('0.0.0.0'), true);
    assert.equal(isPrivateIpv4('0.255.255.255'), true);
    // 10.0.0.0/8 boundaries
    assert.equal(isPrivateIpv4('10.0.0.1'), true);
    assert.equal(isPrivateIpv4('9.255.255.255'), false);
    assert.equal(isPrivateIpv4('11.0.0.0'), false);
    // loopback 127.0.0.0/8
    assert.equal(isPrivateIpv4('127.0.0.1'), true);
    assert.equal(isPrivateIpv4('126.255.255.255'), false);
    // link-local 169.254.0.0/16 boundaries
    assert.equal(isPrivateIpv4('169.254.169.254'), true);
    assert.equal(isPrivateIpv4('169.253.255.255'), false);
    assert.equal(isPrivateIpv4('169.255.0.0'), false);
    // RFC1918 172.16.0.0/12 boundaries
    assert.equal(isPrivateIpv4('172.16.0.0'), true);
    assert.equal(isPrivateIpv4('172.31.255.255'), true);
    assert.equal(isPrivateIpv4('172.15.255.255'), false);
    assert.equal(isPrivateIpv4('172.32.0.0'), false);
    // RFC1918 192.168.0.0/16 boundaries
    assert.equal(isPrivateIpv4('192.168.0.1'), true);
    assert.equal(isPrivateIpv4('192.167.255.255'), false);
    assert.equal(isPrivateIpv4('192.169.0.0'), false);
  }, results);

  await testFunction('isPrivateIpv4 blocks 6to4 relay anycast (192.88.99.0/24)', () => {
    assert.equal(isPrivateIpv4('192.88.99.1'), true);
    assert.equal(isPrivateIpv4('192.88.98.255'), false);
    assert.equal(isPrivateIpv4('192.88.100.0'), false);
  }, results);

  await testFunction('isPrivateIPv6 delegates IPv4-mapped CGNAT addresses to IPv4 check', () => {
    assert.equal(isPrivateIPv6('::ffff:100.64.0.1'), true);
  }, results);

  await testFunction('assertUrlAllowed blocks CGNAT by default and honors private URL override', () => {
    envManager.delete('MCP_HTTP_HARDEN');
    envManager.delete('MCP_HTTP_ALLOW_PRIVATE_URLS');

    try {
      assert.throws(
        () => assertUrlAllowed(new URL('http://100.64.0.1/')),
        /blocked by security policy/,
      );

      envManager.set('MCP_HTTP_ALLOW_PRIVATE_URLS', 'true');
      assert.doesNotThrow(() => assertUrlAllowed(new URL('http://100.64.0.1/')));
    } finally {
      envManager.restore();
    }
  }, results);

  printTestSummary(results, 'URL Security Module');
  return results;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  runTests().then(results => {
    process.exit(results.failed > 0 ? 1 : 0);
  }).catch(console.error);
}

export { runTests };
