#!/usr/bin/env tsx

/**
 * Real-life test for the gzip decompression fix (issue #81).
 *
 * Sends actual HTTPS requests to real websites that serve gzip-encoded
 * responses and verifies the result is readable text — NOT raw gzip bytes.
 *
 * This script is intentionally NOT included in run-all.ts because:
 *   - It makes external network requests (unsuitable for CI without internet)
 *   - It is meant for manual local verification before pushing a fix
 *
 * Run with:
 *   npx tsx __tests__/real-life/test-gzip-fix.ts
 */

import { fetchAndConvertToMarkdown } from '../../src/url-reader.js';
import { createMockServer } from '../helpers/mock-server.js';
import { urlCache } from '../../src/cache.js';

const GZIP_MAGIC = '\x1f\x8b';
const PREVIEW_LENGTH = 400;

interface TestCase {
  name: string;
  url: string;
  expectedFragment?: string; // a string we expect somewhere in the markdown
}

const TEST_CASES: TestCase[] = [
  {
    name: 'Wikipedia — exact URL from issue #81 report',
    url: 'https://en.wikipedia.org/wiki/Firefly_(TV_series)',
    expectedFragment: 'Firefly',
  },
  {
    name: 'example.com — baseline HTTPS',
    url: 'https://example.com',
    expectedFragment: 'Example Domain',
  },
];

// ─── helpers ─────────────────────────────────────────────────────────────────

function pass(msg: string): void {
  console.log(`  ✅ ${msg}`);
}

function fail(msg: string): void {
  console.error(`  ❌ ${msg}`);
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function runRealLifeTests(): Promise<boolean> {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Real-life gzip decompression test  (issue #81)');
  console.log('═══════════════════════════════════════════════════\n');

  const mockServer = createMockServer();
  let allPassed = true;

  for (const tc of TEST_CASES) {
    console.log(`Test: ${tc.name}`);
    console.log(`  URL: ${tc.url}`);
    urlCache.clear();

    let result: string;
    try {
      result = await fetchAndConvertToMarkdown(mockServer as any, tc.url, 30_000);
    } catch (err: any) {
      fail(`fetchAndConvertToMarkdown threw: ${err.message}`);
      allPassed = false;
      console.log();
      continue;
    }

    // Must be a non-empty string
    if (typeof result !== 'string' || result.length === 0) {
      fail('Result is empty');
      allPassed = false;
      console.log();
      continue;
    }
    pass(`Result is a non-empty string (${result.length} chars)`);

    // Must NOT start with gzip magic bytes
    if (result.startsWith(GZIP_MAGIC)) {
      fail('Result starts with raw gzip magic bytes \\x1f\\x8b — decompression failed!');
      allPassed = false;
    } else {
      pass('Result does NOT start with gzip magic bytes');
    }

    // Must contain expected fragment (if provided)
    if (tc.expectedFragment) {
      if (result.includes(tc.expectedFragment)) {
        pass(`Result contains expected fragment: "${tc.expectedFragment}"`);
      } else {
        fail(`Result is missing expected fragment: "${tc.expectedFragment}"`);
        allPassed = false;
      }
    }

    // Print a preview for visual inspection
    console.log('\n  --- First ~400 characters of result ---');
    console.log(result.slice(0, PREVIEW_LENGTH).replace(/\n/g, '\n  '));
    console.log('  ---\n');
  }

  console.log('═══════════════════════════════════════════════════');
  if (allPassed) {
    console.log('  All real-life tests PASSED ✅');
  } else {
    console.log('  Some real-life tests FAILED ❌');
  }
  console.log('═══════════════════════════════════════════════════');

  return allPassed;
}

runRealLifeTests().then((ok) => {
  process.exit(ok ? 0 : 1);
}).catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
