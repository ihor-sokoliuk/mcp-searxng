import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { isWebUrlReadArgs } from "../../src/index.js";
import { isSearXNGWebSearchArgs } from "../../src/types.js";
import { testFunction, createTestResults, printTestSummary } from "../helpers/test-utils.js";

const results = createTestResults();

const validSearchArgs = fc.record(
  {
    query: fc.string(),
    pageno: fc.option(fc.integer({ min: 1, max: 1000 }), { nil: undefined }),
    time_range: fc.option(fc.constantFrom("day", "week", "month", "year"), { nil: undefined }),
    language: fc.option(fc.string(), { nil: undefined }),
    safesearch: fc.option(fc.constantFrom(0, 1, 2), { nil: undefined }),
    min_score: fc.option(fc.constantFrom(0, 0.25, 0.5, 0.75, 1), { nil: undefined }),
  },
  { requiredKeys: ["query"] },
);

const validReadUrlArgs = fc.record(
  {
    url: fc.webUrl(),
    startChar: fc.option(fc.integer({ min: 0, max: 1_000_000 }), { nil: undefined }),
    maxLength: fc.option(fc.integer({ min: 1, max: 1_000_000 }), { nil: undefined }),
    section: fc.option(fc.string(), { nil: undefined }),
    paragraphRange: fc.option(fc.string(), { nil: undefined }),
    readHeadings: fc.option(fc.boolean(), { nil: undefined }),
  },
  { requiredKeys: ["url"] },
);

async function runTests() {
  console.log("🧪 Testing: fuzz/property search parameters\n");

  await testFunction("fast-check: search arg guard never throws on arbitrary input", () => {
    fc.assert(
      fc.property(fc.anything(), (value) => {
        assert.doesNotThrow(() => isSearXNGWebSearchArgs(value));
      }),
    );
  }, results);

  await testFunction("fast-check: generated valid search args are accepted", () => {
    fc.assert(
      fc.property(validSearchArgs, (value) => {
        assert.equal(isSearXNGWebSearchArgs(value), true);
      }),
    );
  }, results);

  await testFunction("fast-check: URL read arg guard never throws on arbitrary input", () => {
    fc.assert(
      fc.property(fc.anything(), (value) => {
        assert.doesNotThrow(() => isWebUrlReadArgs(value));
      }),
    );
  }, results);

  await testFunction("fast-check: generated valid URL read args are accepted", () => {
    fc.assert(
      fc.property(validReadUrlArgs, (value) => {
        assert.equal(isWebUrlReadArgs(value), true);
      }),
    );
  }, results);

  printTestSummary(results, "Fuzz Property Tests");
  return results;
}

// Fuzz entry point — receives arbitrary Buffer from the fuzzer (jazzer.js convention)
export function fuzz(data: Buffer): void {
  const str = data.toString("utf-8");

  // Fuzz URL construction: mirrors what performWebSearch does with query input
  try {
    const url = new URL("https://example.com/search");
    url.searchParams.set("q", str);
    url.searchParams.set("format", "json");
  } catch {
    // malformed input is expected; must not crash the process
  }

  // Fuzz type guard: arbitrary input must never throw — only return true/false
  try {
    const parsed: unknown = JSON.parse(str);
    isSearXNGWebSearchArgs(parsed);
    isWebUrlReadArgs(parsed);
  } catch {
    // invalid JSON is expected
  }
}

// Run if executed directly
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  runTests().then(results => {
    process.exit(results.failed > 0 ? 1 : 0);
  }).catch(console.error);
}

export { runTests };
