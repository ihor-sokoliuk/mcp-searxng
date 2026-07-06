#!/usr/bin/env tsx

/**
 * Unit Tests: tls-config.ts
 *
 * Tests for system CA certificate loading.
 *
 * The real-system tests below exercise the default (no-dependency) code path,
 * while the injected-dependency tests deterministically cover every branch —
 * including the Windows and unreadable-bundle paths — on any host/OS.
 */

import { strict as assert } from 'node:assert';
import { fileURLToPath } from 'node:url';
import { getSystemCACerts, getConnectOptions } from '../../src/tls-config.js';
import { testFunction, createTestResults, printTestSummary } from '../helpers/test-utils.js';

const PEM = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n';

const results = createTestResults();

async function runTests() {
  console.log('🧪 Testing: tls-config.ts\n');

  // --- Real-system path (covers the default platform/fs dependencies) ---

  await testFunction('getSystemCACerts returns string or null', () => {
    const certs = getSystemCACerts();
    assert.ok(certs === null || typeof certs === 'string');
  }, results);

  await testFunction('getSystemCACerts returns null on Windows even when NODE_EXTRA_CA_CERTS is set', () => {
    // On Windows, no system bundle is detected and we deliberately return
    // null so Node's default trust store (Mozilla roots + NODE_EXTRA_CA_CERTS)
    // handles TLS — passing the extra CA as an explicit `ca` would replace
    // that store and drop the public roots.
    if (process.platform === 'win32') {
      const certs = getSystemCACerts();
      assert.equal(certs, null, 'win32 always returns null; extra CA flows through Node default path');
    } else {
      const certs = getSystemCACerts();
      assert.ok(certs === null || (typeof certs === 'string' && certs.length > 0));
    }
  }, results);

  await testFunction('getConnectOptions returns an object', () => {
    const opts = getConnectOptions();
    assert.ok(typeof opts === 'object' && opts !== null);
  }, results);

  await testFunction('getConnectOptions ca content contains PEM header when present', () => {
    const opts = getConnectOptions();
    if ('ca' in opts) {
      assert.ok(
        (opts as { ca: string }).ca.includes('-----BEGIN CERTIFICATE-----'),
        'CA bundle should contain PEM-encoded certificates'
      );
    }
    // No ca key is also valid — means no system bundle was found
  }, results);

  await testFunction('getConnectOptions returns empty object when getSystemCACerts returns null', () => {
    // On Windows without NODE_EXTRA_CA_CERTS this is guaranteed; on other platforms we just check shape
    const opts = getConnectOptions();
    if (getSystemCACerts() === null) {
      assert.deepEqual(opts, {});
    } else {
      assert.ok('ca' in opts);
    }
  }, results);

  // --- Injected dependencies: deterministic branch coverage ---

  await testFunction('getSystemCACerts returns null on win32 when no extra CA is configured', () => {
    let touched = false;
    const certs = getSystemCACerts({
      platformName: 'win32',
      fileExists: () => { touched = true; return true; },
      readFile: () => { touched = true; return PEM; },
      caPaths: ['/should/not/be/read'],
      extraCaPath: null,
    });
    assert.equal(certs, null);
    assert.equal(touched, false, 'win32 skips system bundle discovery and only reads the extra CA path');
  }, results);

  await testFunction('getSystemCACerts returns null on win32 even with NODE_EXTRA_CA_CERTS (no system bundle → defer to Node default)', () => {
    let touched = false;
    const certs = getSystemCACerts({
      platformName: 'win32',
      fileExists: () => { touched = true; return true; },
      readFile: () => { touched = true; return PEM; },
      caPaths: ['/should/not/be/read'],
      extraCaPath: '/opt/extra.pem',
    });
    assert.equal(certs, null, 'win32 defers to Node default trust store; extra CA is honored via NODE_EXTRA_CA_CERTS at the Node level, not by overriding ca');
    assert.equal(touched, false, 'no bundle paths are read on win32; NODE_EXTRA_CA_CERTS is handled by Node itself');
  }, results);

  await testFunction('getSystemCACerts returns null when no system bundle is found even if NODE_EXTRA_CA_CERTS is set', () => {
    // Mirrors the win32 case on a minimal Linux container: no CA_BUNDLE_PATHS
    // match, but NODE_EXTRA_CA_CERTS is set. Returning null lets Node's
    // default trust store (Mozilla + extra) handle TLS, instead of replacing
    // it with the extra CA alone and dropping public roots.
    const certs = getSystemCACerts({
      platformName: 'linux',
      fileExists: () => false,
      readFile: () => { throw new Error('should not be called'); },
      caPaths: ['/nope/a.crt', '/nope/b.crt'],
      extraCaPath: '/opt/extra.pem',
    });
    assert.equal(certs, null, 'no system bundle → defer to Node default; do not override ca with extra alone');
  }, results);

  await testFunction('getSystemCACerts returns the first readable bundle', () => {
    const reads: string[] = [];
    const certs = getSystemCACerts({
      platformName: 'linux',
      fileExists: () => true,
      readFile: (p) => { reads.push(p); return PEM; },
      caPaths: ['/etc/ssl/first.crt', '/etc/ssl/second.crt'],
      extraCaPath: null,
    });
    assert.equal(certs, PEM);
    assert.deepEqual(reads, ['/etc/ssl/first.crt'], 'stops at the first readable bundle');
  }, results);

  await testFunction('getSystemCACerts skips an existing-but-unreadable bundle and tries the next', () => {
    const certs = getSystemCACerts({
      platformName: 'linux',
      fileExists: () => true,
      readFile: (p) => {
        if (p === '/etc/ssl/locked.crt') {
          throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
        }
        return PEM;
      },
      caPaths: ['/etc/ssl/locked.crt', '/etc/ssl/readable.crt'],
      extraCaPath: null,
    });
    assert.equal(certs, PEM, 'falls through the unreadable path to the readable one');
  }, results);

  await testFunction('getSystemCACerts returns null when no candidate path exists', () => {
    const certs = getSystemCACerts({
      platformName: 'linux',
      fileExists: () => false,
      readFile: () => { throw new Error('should not be called'); },
      caPaths: ['/nope/a.crt', '/nope/b.crt'],
      extraCaPath: null,
    });
    assert.equal(certs, null);
  }, results);

  await testFunction('getSystemCACerts returns null when every bundle is unreadable', () => {
    const certs = getSystemCACerts({
      platformName: 'linux',
      fileExists: () => true,
      readFile: () => { throw new Error('EACCES'); },
      caPaths: ['/etc/ssl/a.crt', '/etc/ssl/b.crt'],
      extraCaPath: null,
    });
    assert.equal(certs, null);
  }, results);

  await testFunction('getSystemCACerts merges extra CA bundle into system bundle', () => {
    const certs = getSystemCACerts({
      platformName: 'linux',
      fileExists: () => true,
      readFile: () => PEM,
      caPaths: ['/etc/ssl/found.crt'],
      extraCaPath: '/opt/extra.pem',
    });
    assert.equal(certs, PEM + '\n' + PEM, 'system bundle and extra bundle are joined with a newline');
  }, results);

  await testFunction('getSystemCACerts silently ignores an unreadable extra CA path', () => {
    const certs = getSystemCACerts({
      platformName: 'linux',
      fileExists: () => true,
      readFile: (p) => {
        if (p === '/opt/locked-extra.pem') {
          throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
        }
        return PEM;
      },
      caPaths: ['/etc/ssl/found.crt'],
      extraCaPath: '/opt/locked-extra.pem',
    });
    assert.equal(certs, PEM, 'unreadable extra path is silently dropped');
  }, results);

  await testFunction('getConnectOptions wraps the CA bundle when one is found', () => {
    const opts = getConnectOptions({
      platformName: 'linux',
      fileExists: () => true,
      readFile: () => PEM,
      caPaths: ['/etc/ssl/found.crt'],
      extraCaPath: null,
    });
    assert.deepEqual(opts, { ca: PEM });
  }, results);

  await testFunction('getConnectOptions returns empty object when no CA bundle is found', () => {
    const opts = getConnectOptions({
      platformName: 'linux',
      fileExists: () => false,
      caPaths: ['/nope.crt'],
      extraCaPath: null,
    });
    assert.deepEqual(opts, {});
  }, results);

  printTestSummary(results, 'TLS Config Module');
  return results;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  runTests().then(r => process.exit(r.failed > 0 ? 1 : 0)).catch(console.error);
}

export { runTests };
