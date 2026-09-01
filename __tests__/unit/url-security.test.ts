#!/usr/bin/env tsx

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
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

  await testFunction('isPrivateIPv6 blocks IPv4-translated private addresses', () => {
    assert.equal(isPrivateIPv6('::ffff:0:127.0.0.1'), true);
  }, results);

  await testFunction('isPrivateIPv6 decodes every blocked IPv4 category across embeddings', () => {
    const blockedIpv4 = [
      '0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.169.254',
      '172.16.0.1', '192.0.0.1', '192.0.2.1', '192.88.99.1', '192.168.0.1',
      '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '240.0.0.1',
    ];
    const ipv4To6to4 = (ipv4: string) => {
      const [a, b, c, d] = ipv4.split('.').map(Number);
      return `2002:${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}::`;
    };
    const encodings = [
      (ipv4: string) => `::${ipv4}`,
      (ipv4: string) => `::ffff:${ipv4}`,
      (ipv4: string) => `::ffff:0:${ipv4}`,
      ipv4To6to4,
      (ipv4: string) => `64:ff9b::${ipv4}`,
    ];

    for (const ipv4 of blockedIpv4) {
      for (const encode of encodings) {
        assert.equal(isPrivateIPv6(encode(ipv4)), true, `${encode(ipv4)} should be blocked`);
      }
    }
  }, results);

  await testFunction('isPrivateIPv6 allows public IPv4 payloads across embeddings', () => {
    const publicIpv4 = ['8.8.8.8', '1.1.1.1'];
    const ipv4To6to4 = (ipv4: string) => {
      const [a, b, c, d] = ipv4.split('.').map(Number);
      return `2002:${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}::`;
    };
    const encodings = [
      (ipv4: string) => `::${ipv4}`,
      (ipv4: string) => `::ffff:${ipv4}`,
      (ipv4: string) => `::ffff:0:${ipv4}`,
      ipv4To6to4,
      (ipv4: string) => `64:ff9b::${ipv4}`,
    ];

    for (const ipv4 of publicIpv4) {
      for (const encode of encodings) {
        assert.equal(isPrivateIPv6(encode(ipv4)), false, `${encode(ipv4)} should be allowed`);
      }
    }
  }, results);

  await testFunction('isPrivateIPv6 preserves native denials and blocks RFC8215 local-use prefix', () => {
    for (const address of [
      '::', '0:0:0:0:0:0:0:1', 'fc00::1', 'FD12::1', 'fe80::1', 'febf::1',
      '64:ff9b:1::', '64:ff9b:1:ffff:ffff:ffff:ffff:ffff',
    ]) {
      assert.equal(isPrivateIPv6(address), true, `${address} should be blocked`);
    }
    for (const address of ['64:ff9b:0:ffff::', '64:ff9b:2::']) {
      assert.equal(isPrivateIPv6(address), false, `${address} should remain public`);
    }
  }, results);

  await testFunction('isPrivateIPv6 has exact embedding-prefix boundaries and public neighbors', () => {
    const blocked = [
      '::10.0.0.1',
      '::ffff:10.0.0.1',
      '::ffff:0:10.0.0.1',
      '2002:a00:1:1234:5678:9abc:def0:1',
      '64:ff9b::10.0.0.1',
    ];
    const allowed = [
      '::8.8.8.8',
      '::ffff:8.8.8.8',
      '::ffff:0:8.8.8.8',
      '2002:808:808:1234:5678:9abc:def0:1',
      '64:ff9b::8.8.8.8',
      '::1:10.0.0.1',
      '::fffe:10.0.0.1',
      '::fffe:0:10.0.0.1',
      '2003:a00:1::',
      '64:ff9a::10.0.0.1',
    ];
    for (const address of blocked) {
      assert.equal(isPrivateIPv6(address), true, `${address} should be blocked`);
    }
    for (const address of allowed) {
      assert.equal(isPrivateIPv6(address), false, `${address} should be allowed`);
    }
  }, results);

  await testFunction('isPrivateIPv6 handles compressed, expanded, uppercase, WHATWG, and malformed inputs', () => {
    assert.equal(isPrivateIPv6('::FFFF:7F00:1'), true);
    assert.equal(isPrivateIPv6('0:0:0:0:0:ffff:7f00:1'), true);
    assert.equal(isPrivateIPv6(new URL('http://[::ffff:0:127.0.0.1]/').hostname), true);
    assert.doesNotThrow(() => isPrivateIPv6('not-an-ip'));
    assert.equal(isPrivateIPv6('not-an-ip'), false);
    assert.doesNotThrow(() => isPrivateIPv6('[::ffff:broken]'));
    assert.equal(isPrivateIPv6('[::ffff:broken]'), false);
  }, results);

  await testFunction('isPrivateIPv6 rejects hostile malformed IPv6 candidates without throwing', () => {
    const hostile = [
      '', '2001:db8:', '1:2:3:4:5:6:7:8:9', '2001::db8::1', '20000::1',
      '2001: db8::1', '::ffff:127.0.0.256', '::ffff:127.0.0',
    ];
    for (const address of hostile) {
      assert.doesNotThrow(() => isPrivateIPv6(address), address);
      assert.equal(isPrivateIPv6(address), false, `${address || '<empty>'} should not classify as IPv6`);
    }
    assert.doesNotThrow(() => isPrivateIPv6('fe80::1%eth0'));
    assert.equal(isPrivateIPv6('fe80::1%eth0'), true, 'family-6 parser disagreement must fail closed');
  }, results);

  await testFunction('WHATWG rejects malformed bracketed IPv6 literals before URL dispatch', () => {
    for (const literal of [
      'http://[2001:db8::1::2]/',
      'http://[fe80::1%25eth0]/',
      'http://[1:2:3:4:5:6:7:8:9]/',
    ]) {
      assert.throws(() => new URL(literal), TypeError, literal);
    }
  }, results);

  await testFunction('isPrivateIPv6 permits an ordinary public global-unicast control', () => {
    assert.equal(isPrivateIPv6('2606:4700::1111'), false);
  }, results);

  await testFunction('IPv6 byte parser stays private, follows family validation, and fails closed', () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- repository source URL is compile-time constant
    const source = readFileSync(new URL('../../src/url-security.ts', import.meta.url), 'utf8');
    assert.match(source, /function parseIpv6Bytes\(/);
    assert.doesNotMatch(source, /export\s+(?:function|const)\s+parseIpv6Bytes/);
    const familyValidation = source.indexOf('isIP(addr) !== 6');
    const parserCall = source.indexOf('parseIpv6Bytes(addr)');
    assert.ok(familyValidation >= 0 && familyValidation < parserCall);
    assert.match(source, /catch\s*\{\s*return true;\s*\}/);
    assert.match(source, /bytes\.length !== 16\)\s*return true;/);
  }, results);

  await testFunction('security documentation describes embedding limits without overclaiming coverage', () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- repository documentation URL is compile-time constant
    const security = readFileSync(new URL('../../SECURITY.md', import.meta.url), 'utf8');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- repository documentation URL is compile-time constant
    const configuration = readFileSync(new URL('../../CONFIGURATION.md', import.meta.url), 'utf8');
    const requiredTerms = [
      '::/96', '::ffff:0:0/96', '::ffff:0:0:0/96', '2002::/16', '64:ff9b::/96',
      '64:ff9b:1::/48', 'whole-prefix local-use denial', 'Teredo', 'Network-Specific Prefix',
      'routing or firewall controls', 'untrusted URL reading',
      'do not claim complete NAT64 or complete transition coverage',
    ];
    for (const document of [security, configuration]) {
      for (const term of requiredTerms) {
        assert.ok(document.includes(term), `Missing documentation term ${term}`);
      }
    }
    assert.match(configuration, /explicit proxy-side controls/i);
    assert.match(configuration, /Residual proxy-resolution boundary/i);
    const affirmativeOverclaim = /(?<!do not claim )\bcomplete NAT64 coverage\b|(?<!do not claim complete NAT64 or )\bcomplete transition coverage\b|\ball NAT64\b/i;
    assert.doesNotMatch(security, affirmativeOverclaim);
    assert.doesNotMatch(configuration, affirmativeOverclaim);
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
      assert.doesNotThrow(() => assertUrlAllowed(new URL('http://[::ffff:0:127.0.0.1]/')));
      assert.doesNotThrow(() => assertUrlAllowed(new URL('http://[64:ff9b:1::1]/')));
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
