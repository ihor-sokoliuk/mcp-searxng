#!/usr/bin/env tsx

import { strict as assert } from 'node:assert';
import { fileURLToPath } from 'node:url';
import {
  createTestResults,
  printTestSummary,
  testFunction,
} from '../helpers/test-utils.js';
import { snapshotProcessEnv } from '../helpers/env-utils.js';

const results = createTestResults();
const isolationKey = 'MCP_SEARXNG_TEST_ENV_ISOLATION';

async function runTests() {
  console.log('🧪 Testing: test-utils.ts\n');

  await testFunction('testFunction restores process.env after callbacks pass or fail', async () => {
    const originalValue = process.env[isolationKey];
    const originalLog = console.log;
    const nestedResults = createTestResults();

    try {
      delete process.env[isolationKey];
      console.log = () => {};

      await testFunction('intentional failure', () => {
        process.env[isolationKey] = 'failed-test-value';
        throw new Error('intentional harness failure');
      }, nestedResults);

      assert.equal(nestedResults.failed, 1);
      assert.equal(process.env[isolationKey], undefined);

      process.env[isolationKey] = 'baseline-value';
      await testFunction('intentional success', () => {
        process.env[isolationKey] = 'successful-test-value';
      }, nestedResults);

      assert.equal(nestedResults.passed, 1);
      assert.equal(process.env[isolationKey], 'baseline-value');
    } finally {
      console.log = originalLog;
      if (originalValue === undefined) {
        delete process.env[isolationKey];
      } else {
        process.env[isolationKey] = originalValue;
      }
    }
  }, results);

  await testFunction('snapshotProcessEnv preserves prototype-like environment keys', () => {
    const key = '__proto__';
    const originalValue = process.env[key];

    try {
      process.env[key] = 'prototype-key-value';
      const snapshot = snapshotProcessEnv();

      assert.equal(Object.getPrototypeOf(snapshot), null);
      assert.equal(Object.hasOwn(snapshot, key), true);
      assert.equal(snapshot[key], 'prototype-key-value');
    } finally {
      if (originalValue === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalValue;
      }
    }
  }, results);

  printTestSummary(results, 'Test Utilities');
  return results;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  runTests().then((testResults) => {
    process.exit(testResults.failed > 0 ? 1 : 0);
  }).catch(console.error);
}

export { runTests };
