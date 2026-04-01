#!/usr/bin/env tsx

/**
 * Unit Tests: tls-config.ts
 *
 * Tests for system CA certificate loading
 */

import { strict as assert } from 'node:assert';
import { getSystemCACerts, getConnectOptions } from '../../src/tls-config.js';
import { testFunction, createTestResults, printTestSummary } from '../helpers/test-utils.js';

const results = createTestResults();

async function runTests() {
  console.log('🧪 Testing: tls-config.ts\n');

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

  printTestSummary(results, 'TLS Config Module');
  return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runTests().then(r => process.exit(r.failed > 0 ? 1 : 0)).catch(console.error);
}

export { runTests };
