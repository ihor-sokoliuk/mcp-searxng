#!/usr/bin/env tsx

import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";
import {
  initializeDiagnosticSanitizer,
  resetDiagnosticSanitizerForTests,
  sanitizeDiagnosticText,
  sanitizeDiagnosticValue,
  sanitizeErrorForTransport,
} from "../../src/diagnostic-sanitizer.js";
import {
  createTestResults,
  printTestSummary,
  testFunction,
} from "../helpers/test-utils.js";

const results = createTestResults();

function withCredentials<T>(
  env: NodeJS.ProcessEnv,
  callback: () => T,
): T {
  resetDiagnosticSanitizerForTests();
  initializeDiagnosticSanitizer(env);
  try {
    return callback();
  } finally {
    resetDiagnosticSanitizerForTests();
  }
}

async function runTests() {
  console.log("Testing: diagnostic-sanitizer.ts\n");

  await testFunction("sanitizes configured URL, password, Basic, and URI forms", () => {
    const username = "marker-user";
    const password = "p@ss/Marker";
    const pair = `${username}:${password}`;
    const basic = Buffer.from(pair).toString("base64");
    const base64url = Buffer.from(pair).toString("base64url");
    const configuredUrl = "https://marker-user:p%40ss%2FMarker@search.example.com/path";

    withCredentials({ SEARXNG_URL: configuredUrl }, () => {
      const encoded = encodeURIComponent(password);
      const doubleEncoded = encodeURIComponent(encoded);
      const input = [
        configuredUrl,
        password,
        pair,
        `Basic ${basic}`,
        base64url,
        encoded,
        encoded.toLowerCase(),
        doubleEncoded,
      ].join(" | ");
      const sanitized = sanitizeDiagnosticText(input);

      for (const secret of [username + ":", password, pair, basic, base64url, encoded, doubleEncoded]) {
        assert.ok(!sanitized.includes(secret), `leaked ${secret}: ${sanitized}`);
      }
      assert.ok(sanitized.includes("search.example.com/path"), sanitized);
      assert.ok(sanitized.includes("[redacted]"), sanitized);
    });
  }, results);

  await testFunction("globally redacts short passwords but not unrelated bare usernames", () => {
    withCredentials(
      { AUTH_USERNAME: "admin", AUTH_PASSWORD: "x" },
      () => {
        const sanitized = sanitizeDiagnosticText(
          "admin viewed page; password=x; pair admin:x",
        );
        assert.ok(sanitized.includes("admin viewed page"), sanitized);
        assert.ok(!sanitized.includes("password=x"), sanitized);
        assert.ok(!sanitized.includes("admin:x"), sanitized);
      },
    );
  }, results);

  await testFunction("retains the startup snapshot after environment mutation", () => {
    const env = {
      AUTH_USERNAME: "snapshot-user",
      AUTH_PASSWORD: "snapshot-secret",
    };
    resetDiagnosticSanitizerForTests();
    initializeDiagnosticSanitizer(env);
    env.AUTH_PASSWORD = "changed";

    const sanitized = sanitizeDiagnosticText("snapshot-secret changed");
    assert.ok(!sanitized.includes("snapshot-secret"), sanitized);
    assert.ok(sanitized.includes("changed"), sanitized);
    resetDiagnosticSanitizerForTests();
  }, results);

  await testFunction("sanitizes errors, causes, arrays, and structured auth fields", () => {
    withCredentials(
      { AUTH_USERNAME: "structured-user", AUTH_PASSWORD: "structured-secret" },
      () => {
        const cause = new Error("cause structured-secret");
        const error = new Error("outer structured-secret", { cause });
        Object.assign(error, {
          authorization: `Basic ${Buffer.from("structured-user:structured-secret").toString("base64")}`,
          details: [{ username: "structured-user", password: "structured-secret" }],
        });

        const sanitized = sanitizeDiagnosticValue(error);
        const serialized = JSON.stringify(sanitized);
        assert.ok(!serialized.includes("structured-user"), serialized);
        assert.ok(!serialized.includes("structured-secret"), serialized);

        const transported = sanitizeErrorForTransport(error);
        assert.ok(!transported.message.includes("structured-secret"));
        assert.ok(!transported.stack?.includes("structured-secret"));
      },
    );
  }, results);

  await testFunction("cycles, exhausted depth, and throwing getters fail closed", () => {
    withCredentials(
      { AUTH_USERNAME: "bounded-user", AUTH_PASSWORD: "bounded-secret" },
      () => {
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;
        Object.defineProperty(cyclic, "broken", {
          enumerable: true,
          get() {
            throw new Error("bounded-secret");
          },
        });
        let deep: Record<string, unknown> = { value: "bounded-secret" };
        for (let index = 0; index < 20; index += 1) {
          deep = { next: deep };
        }
        cyclic.deep = deep;

        const serialized = JSON.stringify(sanitizeDiagnosticValue(cyclic));
        assert.ok(!serialized.includes("bounded-secret"), serialized);
        assert.ok(serialized.includes("[redacted diagnostic]"), serialized);
        assert.ok(serialized.includes("[unavailable]"), serialized);
      },
    );
  }, results);

  await testFunction("credential-free diagnostic values stay useful", () => {
    withCredentials({}, () => {
      const input = "Connection refused for search.example.com (ECONNREFUSED)";
      assert.equal(sanitizeDiagnosticText(input), input);
    });
  }, results);

  await testFunction("empty credentials never become replacement patterns", () => {
    withCredentials(
      { AUTH_USERNAME: "", AUTH_PASSWORD: "" },
      () => {
        assert.equal(
          sanitizeDiagnosticText("ordinary diagnostic"),
          "ordinary diagnostic",
        );
      },
    );
  }, results);

  await testFunction("size, collection, proxy, and public failures remain opaque", () => {
    withCredentials({}, () => {
      assert.equal(
        sanitizeDiagnosticText("a".repeat(64 * 1024 + 1)),
        "[redacted diagnostic]",
      );

      const array = Array.from({ length: 101 }, (_, index) => index);
      const sanitizedArray = sanitizeDiagnosticValue(array) as unknown[];
      assert.equal(sanitizedArray.at(-1), "[redacted diagnostic]");

      const ownKeysFailure = new Proxy({}, {
        ownKeys() {
          throw new Error("must not escape");
        },
      });
      assert.equal(
        sanitizeDiagnosticValue(ownKeysFailure),
        "[redacted diagnostic]",
      );

      const arrayFailure = new Proxy([], {
        get(_target, property) {
          if (property === "slice") throw new Error("must not escape");
          return Reflect.get(_target, property);
        },
      });
      assert.equal(
        sanitizeDiagnosticValue(arrayFailure),
        "[redacted diagnostic]",
      );

      const errorFailure = new Proxy({}, {
        getPrototypeOf() {
          throw new Error("must not escape");
        },
      });
      assert.equal(
        sanitizeErrorForTransport(errorFailure).message,
        "[redacted diagnostic]",
      );
    });
  }, results);

  printTestSummary(results, "Diagnostic Sanitizer Module");
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
