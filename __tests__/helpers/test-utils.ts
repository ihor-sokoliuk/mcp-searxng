/**
 * Test Utilities
 * 
 * Shared utility functions for test suite
 */

import { restoreProcessEnv, snapshotProcessEnv } from './env-utils.js';

export interface TestResult {
  passed: number;
  failed: number;
  errors: string[];
}

export const createTestResults = (): TestResult => ({
  passed: 0,
  failed: 0,
  errors: []
});

/**
 * Test function wrapper with consistent error handling
 */
export async function testFunction(
  name: string,
  fn: () => void | Promise<void>,
  results: TestResult
): Promise<void> {
  console.log(`Testing ${name}...`);
  const environmentSnapshot = snapshotProcessEnv();
  try {
    const result = fn();
    if (result instanceof Promise) {
      await result;
    }
    results.passed++;
    console.log(`✅ ${name} passed`);
  } catch (error: any) {
    results.failed++;
    const errorMsg = `❌ ${name} failed: ${error.message}`;
    results.errors.push(errorMsg);
    console.log(errorMsg);
  } finally {
    restoreProcessEnv(environmentSnapshot);
  }
}

/**
 * Print test results summary
 */
export function printTestSummary(results: TestResult, suiteName: string): void {
  console.log(`\n🏁 ${suiteName} Results:`);
  console.log(`✅ Passed: ${results.passed}`);
  console.log(`❌ Failed: ${results.failed}`);
  
  if (results.failed > 0) {
    console.log(`📊 Success Rate: ${Math.round((results.passed / (results.passed + results.failed)) * 100)}%`);
    console.log('\n❌ Failed Tests:');
    results.errors.forEach(error => console.log(error));
  } else {
    console.log('📊 Success Rate: 100%');
  }
}

/**
 * Verify test results and exit with appropriate code
 */
export function exitWithResults(results: TestResult): void {
  if (results.failed === 0) {
    console.log('\n🎉 SUCCESS: All tests passed!');
    process.exit(0);
  } else {
    console.log('\n⚠️  Some tests failed - check the errors above');
    process.exit(1);
  }
}
