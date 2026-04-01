#!/usr/bin/env tsx

/**
 * Main Test Runner
 * 
 * Executes all test suites and provides comprehensive reporting
 */

import { TestResult } from './helpers/test-utils.js';

// Import all test suites
import { runTests as runLoggingTests } from './unit/logging.test.js';
import { runTests as runTypesTests } from './unit/types.test.js';
import { runTests as runCacheTests } from './unit/cache.test.js';
import { runTests as runProxyTests } from './unit/proxy.test.js';
import { runTests as runErrorHandlerTests } from './unit/error-handler.test.js';
import { runTests as runResourcesTests } from './unit/resources.test.js';
import { runTests as runSearchTests } from './unit/search.test.js';
import { runTests as runUrlReaderTests } from './unit/url-reader.test.js';
import { runTests as runTlsConfigTests } from './unit/tls-config.test.js';
import { runTests as runHttpServerTests } from './integration/http-server.test.js';
import { runTests as runIndexTests } from './integration/index.test.js';

interface TestSuite {
  name: string;
  category: 'unit' | 'integration';
  run: () => Promise<TestResult>;
}

const testSuites: TestSuite[] = [
  // Unit Tests
  { name: 'Logging', category: 'unit', run: runLoggingTests },
  { name: 'Types', category: 'unit', run: runTypesTests },
  { name: 'Cache', category: 'unit', run: runCacheTests },
  { name: 'Proxy', category: 'unit', run: runProxyTests },
  { name: 'Error Handler', category: 'unit', run: runErrorHandlerTests },
  { name: 'Resources', category: 'unit', run: runResourcesTests },
  { name: 'Search', category: 'unit', run: runSearchTests },
  { name: 'URL Reader', category: 'unit', run: runUrlReaderTests },
  { name: 'TLS Config', category: 'unit', run: runTlsConfigTests },

  // Integration Tests
  { name: 'HTTP Server', category: 'integration', run: runHttpServerTests },
  { name: 'Main Index', category: 'integration', run: runIndexTests },
];

async function runAllTests() {
  console.log('🚀 MCP SearXNG Server - Production Test Suite\n');
  console.log('===============================================\n');

  const allResults: Array<{ suite: string; category: string; result: TestResult }> = [];
  let totalPassed = 0;
  let totalFailed = 0;

  // Run unit tests
  console.log('📦 UNIT TESTS\n');
  console.log('---\n');

  for (const suite of testSuites.filter(s => s.category === 'unit')) {
    try {
      const result = await suite.run();
      allResults.push({ suite: suite.name, category: suite.category, result });
      totalPassed += result.passed;
      totalFailed += result.failed;
      console.log(''); // Add spacing between test suites
    } catch (error) {
      console.error(`❌ Error running ${suite.name} tests:`, error);
      totalFailed++;
    }
  }

  // Run integration tests
  console.log('\n🔗 INTEGRATION TESTS\n');
  console.log('---\n');

  for (const suite of testSuites.filter(s => s.category === 'integration')) {
    try {
      const result = await suite.run();
      allResults.push({ suite: suite.name, category: suite.category, result });
      totalPassed += result.passed;
      totalFailed += result.failed;
      console.log(''); // Add spacing between test suites
    } catch (error) {
      console.error(`❌ Error running ${suite.name} tests:`, error);
      totalFailed++;
    }
  }

  // Print comprehensive summary
  console.log('\n===============================================');
  console.log('🏁 FINAL TEST SUMMARY\n');

  console.log('📊 Overall Results:');
  console.log(`   Total Tests: ${totalPassed + totalFailed}`);
  console.log(`   ✅ Passed: ${totalPassed}`);
  console.log(`   ❌ Failed: ${totalFailed}`);
  
  const successRate = totalFailed === 0 ? 100 : Math.round((totalPassed / (totalPassed + totalFailed)) * 100);
  console.log(`   Success Rate: ${successRate}%`);

  console.log('\n📋 Per-Suite Breakdown:');
  for (const { suite, category, result } of allResults) {
    const icon = result.failed === 0 ? '✅' : '❌';
    const rate = result.failed === 0 ? '100%' : 
      Math.round((result.passed / (result.passed + result.failed)) * 100) + '%';
    console.log(`   ${icon} ${suite} (${category}): ${result.passed}/${result.passed + result.failed} (${rate})`);
  }

  // Show failed tests if any
  if (totalFailed > 0) {
    console.log('\n❌ Failed Tests:');
    for (const { suite, result } of allResults) {
      if (result.errors.length > 0) {
        console.log(`\n   ${suite}:`);
        result.errors.forEach(error => console.log(`     ${error}`));
      }
    }
  }

  console.log('\n===============================================');

  if (totalFailed === 0) {
    console.log('\n🎉 SUCCESS: All tests passed!');
    console.log('✨ Production-ready test suite completed successfully\n');
    process.exit(0);
  } else {
    console.log('\n⚠️  Some tests failed - review errors above');
    console.log(`💡 ${totalFailed} test(s) need attention\n`);
    process.exit(1);
  }
}

// Run all tests
runAllTests().catch((error) => {
  console.error('Fatal error running tests:', error);
  process.exit(1);
});
