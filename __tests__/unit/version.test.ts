#!/usr/bin/env tsx

/**
 * Unit Tests: version.ts
 *
 * Tests for the packageVersion constant in the dedicated version module.
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { packageVersion } from '../../src/version.js';
import { testFunction, createTestResults, printTestSummary, TestResult } from '../helpers/test-utils.js';

const results = createTestResults();

export async function runTests(): Promise<TestResult> {
  console.log('🧪 Testing: version.ts\n');

  await testFunction('packageVersion is a non-empty string', () => {
    assert.equal(typeof packageVersion, 'string');
    assert.ok(packageVersion.length > 0);
  }, results);

  await testFunction('packageVersion matches package.json', () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is a compile-time constant, not user input
    const pkgJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf-8'));
    assert.equal(packageVersion, pkgJson.version);
  }, results);

  await testFunction('packageVersion matches semver format', () => {
    assert.match(packageVersion, /^\d+\.\d+\.\d+/);
  }, results);

  printTestSummary(results, 'Version Module');
  return results;
}

runTests();
