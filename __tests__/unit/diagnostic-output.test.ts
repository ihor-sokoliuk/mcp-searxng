#!/usr/bin/env tsx

import { strict as assert } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  initializeDiagnosticSanitizer,
  resetDiagnosticSanitizerForTests,
} from "../../src/diagnostic-sanitizer.js";
import { writeDiagnostic } from "../../src/diagnostic-output.js";
import {
  createTestResults,
  printTestSummary,
  testFunction,
} from "../helpers/test-utils.js";

const results = createTestResults();

async function runTests() {
  console.log("Testing: diagnostic-output.ts\n");

  await testFunction("writeDiagnostic sanitizes every value before console output", () => {
    resetDiagnosticSanitizerForTests();
    initializeDiagnosticSanitizer({
      AUTH_USERNAME: "output-user",
      AUTH_PASSWORD: "output-secret",
    });
    const originalError = console.error;
    const calls: unknown[][] = [];
    console.error = (...args: unknown[]) => calls.push(args);
    try {
      writeDiagnostic(
        "error",
        "failed output-user:output-secret",
        new Error("stack output-secret"),
        { password: "output-secret" },
      );
    } finally {
      console.error = originalError;
      resetDiagnosticSanitizerForTests();
    }

    const output = calls.flat().map((value) => (
      value instanceof Error ? `${value.message}\n${value.stack}` : JSON.stringify(value)
    )).join("\n");
    assert.ok(!output.includes("output-user"), output);
    assert.ok(!output.includes("output-secret"), output);
    assert.ok(output.includes("[redacted]"), output);
  }, results);

  await testFunction("production diagnostics cannot bypass sanitizing chokepoints", () => {
    const sourceDirectory = fileURLToPath(new URL("../../src/", import.meta.url));
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed repository src directory
    const files = readdirSync(sourceDirectory)
      .filter((name) => name.endsWith(".ts") && name !== "diagnostic-output.ts");
    const violations: string[] = [];

    for (const name of files) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- names come from the fixed src directory
      const source = readFileSync(new URL(`../../src/${name}`, import.meta.url), "utf8");
      if (/\bconsole\.(?:log|warn|error)\s*\(/u.test(source)) {
        violations.push(`${name}: direct console output`);
      }
      if (/\bprocess\.(?:stdout|stderr)\.write\s*\(/u.test(source)) {
        violations.push(`${name}: direct process output`);
      }
      if (name !== "logging.ts" && /\.sendLoggingMessage\s*\(/u.test(source)) {
        violations.push(`${name}: direct MCP logging notification`);
      }
    }

    assert.deepEqual(violations, []);
  }, results);

  printTestSummary(results, "Diagnostic Output Module");
  return results;
}

if (
  process.argv[1] !== undefined
  && fileURLToPath(import.meta.url) === process.argv[1]
) {
  runTests().then((testResults) => {
    process.exit(testResults.failed > 0 ? 1 : 0);
  }).catch(console.error);
}

export { runTests };
