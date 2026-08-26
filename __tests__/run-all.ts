#!/usr/bin/env tsx

/**
 * Main Test Runner
 * 
 * Executes all test suites and provides comprehensive reporting
 */

import { TestResult } from './helpers/test-utils.js';

// Import all test suites
import { runTests as runLoggingTests } from './unit/logging.test.js';
import { runTests as runTestUtilsTests } from './unit/test-utils.test.js';
import { runTests as runDiagnosticSanitizerTests } from './unit/diagnostic-sanitizer.test.js';
import { runTests as runDiagnosticOutputTests } from './unit/diagnostic-output.test.js';
import { runTests as runTypesTests } from './unit/types.test.js';
import { runTests as runCacheTests } from './unit/cache.test.js';
import { runTests as runSearchCacheTests } from './unit/search-cache.test.js';
import { runTests as runProxyTests } from './unit/proxy.test.js';
import { runTests as runBrowserSolverTests } from './unit/browser-solver.test.js';
import { runTests as runBrowserSolverStateTests } from './unit/browser-solver-state.test.js';
import { runTests as runPdfReaderTests } from './unit/pdf-reader.test.js';
import { runTests as runPdfNetworkGuardTests } from './unit/pdf-network-guard.test.js';
import { runTests as runErrorHandlerTests } from './unit/error-handler.test.js';
import { runTests as runSearxngInstancesTests } from './unit/searxng-instances.test.js';
import { runTests as runResourcesTests } from './unit/resources.test.js';
import { runTests as runSearchTests } from './unit/search.test.js';
import { runTests as runSuggestionsTests } from './unit/suggestions.test.js';
import { runTests as runInstanceInfoTests } from './unit/instance-info.test.js';
import { runTests as runUrlReaderTests } from './unit/url-reader.test.js';
import { runTests as runWebImagesTests } from './unit/web-images.test.js';
import { runTests as runUrlSecurityTests } from './unit/url-security.test.js';
import { runTests as runTlsConfigTests } from './unit/tls-config.test.js';
import { runTests as runHttpServerUnitTests } from './unit/http-server.test.js';
import { runTests as runVersionTests } from './unit/version.test.js';
import { runTests as runHttpSecurityTests } from './unit/http-security.test.js';
import { runTests as runPackedConsumerTests } from './unit/packed-consumer.test.js';
import { runTests as runDocumentationTests } from './unit/documentation.test.js';
import { runTests as runSearxngResponseTests } from './unit/searxng-response.test.js';
import { runTests as runFuzzTests } from './fuzz/search-params.fuzz.js';
import { runTests as runHttpServerTests } from './integration/http-server.test.js';
import { runTests as runIndexTests } from './integration/index.test.js';
import { runTests as runMcpHandlersTests } from './integration/mcp-handlers.test.js';
import { runTests as runCliTests } from './integration/cli.test.js';
import { runTests as runDiagnosticSecurityTests } from './integration/diagnostic-security.test.js';

interface TestSuite {
  name: string;
  category: 'unit' | 'integration';
  run: () => Promise<TestResult>;
}

const testSuites: TestSuite[] = [
  // Unit Tests
  { name: 'Logging', category: 'unit', run: runLoggingTests },
  { name: 'Test Utilities', category: 'unit', run: runTestUtilsTests },
  { name: 'Diagnostic Sanitizer', category: 'unit', run: runDiagnosticSanitizerTests },
  { name: 'Diagnostic Output', category: 'unit', run: runDiagnosticOutputTests },
  { name: 'Types', category: 'unit', run: runTypesTests },
  { name: 'Cache', category: 'unit', run: runCacheTests },
  { name: 'Search Cache', category: 'unit', run: runSearchCacheTests },
  { name: 'Proxy', category: 'unit', run: runProxyTests },
  { name: 'Browser Solver', category: 'unit', run: runBrowserSolverTests },
  { name: 'Browser Solver State', category: 'unit', run: runBrowserSolverStateTests },
  { name: 'PDF Reader', category: 'unit', run: runPdfReaderTests },
  { name: 'PDF Network Guard', category: 'unit', run: runPdfNetworkGuardTests },
  { name: 'Error Handler', category: 'unit', run: runErrorHandlerTests },
  { name: 'SearXNG Instances', category: 'unit', run: runSearxngInstancesTests },
  { name: 'Resources', category: 'unit', run: runResourcesTests },
  { name: 'Search', category: 'unit', run: runSearchTests },
  { name: 'Suggestions', category: 'unit', run: runSuggestionsTests },
  { name: 'Instance Info', category: 'unit', run: runInstanceInfoTests },
  { name: 'URL Reader', category: 'unit', run: runUrlReaderTests },
  { name: 'Web Images', category: 'unit', run: runWebImagesTests },
  { name: 'URL Security', category: 'unit', run: runUrlSecurityTests },
  { name: 'TLS Config', category: 'unit', run: runTlsConfigTests },
  { name: 'HTTP Server', category: 'unit', run: runHttpServerUnitTests },
  { name: 'Version', category: 'unit', run: runVersionTests },
  { name: 'HTTP Security', category: 'unit', run: runHttpSecurityTests },
  { name: 'Packed Consumer Verification', category: 'unit', run: runPackedConsumerTests },
  { name: 'Documentation', category: 'unit', run: runDocumentationTests },
  { name: 'SearXNG Response', category: 'unit', run: runSearxngResponseTests },
  { name: 'Fuzz Properties', category: 'unit', run: runFuzzTests },

  // Integration Tests
  { name: 'HTTP Server', category: 'integration', run: runHttpServerTests },
  { name: 'Main Index', category: 'integration', run: runIndexTests },
  { name: 'MCP Handlers', category: 'integration', run: runMcpHandlersTests },
  { name: 'CLI', category: 'integration', run: runCliTests },
  { name: 'Credential-Safe Diagnostics', category: 'integration', run: runDiagnosticSecurityTests },
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
