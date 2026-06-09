#!/usr/bin/env tsx

/**
 * E2E Test Runner
 *
 * Runs all e2e suites. Live-URL suites skip gracefully when SEARXNG_LIVE_URL is unset.
 * The timeout suite always runs (uses a local hanging server, no live URL needed).
 *
 * Usage:
 *   npm run test:e2e
 *   SEARXNG_LIVE_URL=https://your-searxng-instance.example.com npm run test:e2e
 */

import { LIVE_URL } from './helpers/spawn-server.js';
import { runTests as runSearchTests } from './search.e2e.js';
import { runTests as runUrlReaderTests } from './url-reader.e2e.js';
import { runTests as runTimeoutTests } from './timeout.e2e.js';

async function main() {
  console.log('🚀 MCP SearXNG — E2E Test Suite\n');
  console.log('===========================================\n');

  if (LIVE_URL) {
    console.log(`🌐 Live SearXNG: ${LIVE_URL}\n`);
  } else {
    console.log('⚠️  SEARXNG_LIVE_URL not set — live tests will be skipped\n');
  }

  let totalPassed = 0;
  let totalFailed = 0;

  for (const { name, run } of [
    { name: 'Web Search (live)', run: runSearchTests },
    { name: 'URL Reader (live)', run: runUrlReaderTests },
    { name: 'Timeout (local)', run: runTimeoutTests },
  ]) {
    try {
      const result = await run();
      totalPassed += result.passed;
      totalFailed += result.failed;
      console.log('');
    } catch (error) {
      console.error(`❌ Error running ${name}:`, error);
      totalFailed++;
    }
  }

  console.log('\n===========================================');
  console.log(`🏁 E2E Summary: ${totalPassed} passed, ${totalFailed} failed\n`);

  process.exit(totalFailed > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
