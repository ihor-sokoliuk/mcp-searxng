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

  await testFunction('getSystemCACerts returns null on Windows, string-or-null elsewhere', () => {
    if (process.platform === 'win32') {
      assert.equal(getSystemCACerts(), null);
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
    // On Windows this is guaranteed; on other platforms we just check shape
    const opts = getConnectOptions();
    if (getSystemCACerts() === null) {
      assert.deepEqual(opts, {});
    } else {
      assert.ok('ca' in opts);
    }
  }, results);

  // --- Injected dependencies: deterministic branch coverage ---

  await testFunction('getSystemCACerts returns null on win32 without touching the filesystem', () => {
    let touched = false;
    const certs = getSystemCACerts({
      platformName: 'win32',
      fileExists: () => { touched = true; return true; },
      readFile: () => { touched = true; return PEM; },
      caPaths: ['/should/not/be/read'],
    });
    assert.equal(certs, null);
    assert.equal(touched, false, 'win32 short-circuits before any fs access');
  }, results);

  await testFunction('getSystemCACerts returns the first readable bundle', () => {
    const reads: string[] = [];
    const certs = getSystemCACerts({
      platformName: 'linux',
      fileExists: () => true,
      readFile: (p) => { reads.push(p); return PEM; },
      caPaths: ['/etc/ssl/first.crt', '/etc/ssl/second.crt'],
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
    });
    assert.equal(certs, PEM, 'falls through the unreadable path to the readable one');
  }, results);

  await testFunction('getSystemCACerts returns null when no candidate path exists', () => {
    const certs = getSystemCACerts({
      platformName: 'linux',
      fileExists: () => false,
      readFile: () => { throw new Error('should not be called'); },
      caPaths: ['/nope/a.crt', '/nope/b.crt'],
    });
    assert.equal(certs, null);
  }, results);

  await testFunction('getSystemCACerts returns null when every bundle is unreadable', () => {
    const certs = getSystemCACerts({
      platformName: 'linux',
      fileExists: () => true,
      readFile: () => { throw new Error('EACCES'); },
      caPaths: ['/etc/ssl/a.crt', '/etc/ssl/b.crt'],
    });
    assert.equal(certs, null);
  }, results);

  await testFunction('getConnectOptions wraps the CA bundle when one is found', () => {
    const opts = getConnectOptions({
      platformName: 'linux',
      fileExists: () => true,
      readFile: () => PEM,
      caPaths: ['/etc/ssl/found.crt'],
    });
    assert.deepEqual(opts, { ca: PEM });
  }, results);

  await testFunction('getConnectOptions returns empty object when no CA bundle is found', () => {
    const opts = getConnectOptions({
      platformName: 'linux',
      fileExists: () => false,
      caPaths: ['/nope.crt'],
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
