#!/usr/bin/env tsx

/**
 * Unit Tests: instance-info.ts
 *
 * Tests for SearXNG instance discovery functionality.
 */

import { strict as assert } from "node:assert";
import {
  fetchInstanceConfig,
  formatInstanceInfo,
  getInstanceInfo,
} from "../../src/instance-info.js";
import { createMockServer } from "../helpers/mock-server.js";
import {
  FetchMocker,
  createCapturingMockFetch,
  createMockFetch,
} from "../helpers/mock-fetch.js";
import {
  createTestResults,
  printTestSummary,
  testFunction,
} from "../helpers/test-utils.js";
import { EnvManager } from "../helpers/env-utils.js";

const results = createTestResults();
const fetchMocker = new FetchMocker();
const envManager = new EnvManager();

async function runTests() {
  console.log("🧪 Testing: instance-info.ts\n");

  await testFunction("Error handling for missing SEARXNG_URL", async () => {
    envManager.delete("SEARXNG_URL");

    const mockServer = createMockServer();

    try {
      await fetchInstanceConfig(mockServer as any);
      assert.fail("Should have thrown configuration error");
    } catch (error: any) {
      assert.ok(
        error.message.includes("SEARXNG_URL not set") ||
          error.message.includes("Configuration")
      );
    }

    envManager.restore();
  }, results);

  await testFunction("Config URL construction with subpath", async () => {
    envManager.set("SEARXNG_URL", "https://test-searx.example.com/subpath");

    const mockServer = createMockServer();
    const capture = createCapturingMockFetch();

    fetchMocker.mock(async (url, options) => {
      await capture.mockFetch(url, options);
      throw new Error("MOCK_NETWORK_ERROR");
    });

    try {
      await fetchInstanceConfig(mockServer as any);
    } catch {
      // Expected mock failure after capture.
    }

    const url = new URL(capture.getCapturedUrl());
    assert.ok(
      url.pathname.includes("/subpath/config"),
      `Expected path to contain /subpath/config, got ${url.pathname}`
    );

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction("Authentication header construction", async () => {
    envManager.set("SEARXNG_URL", "https://test-searx.example.com");
    envManager.set("AUTH_USERNAME", "testuser");
    envManager.set("AUTH_PASSWORD", "testpass");

    const mockServer = createMockServer();
    const capture = createCapturingMockFetch();

    fetchMocker.mock(async (url, options) => {
      await capture.mockFetch(url, options);
      throw new Error("MOCK_NETWORK_ERROR");
    });

    try {
      await fetchInstanceConfig(mockServer as any);
    } catch {
      // Expected mock failure after capture.
    }

    const options = capture.getCapturedOptions();
    const headers = options?.headers as Record<string, string>;
    assert.ok(headers.Authorization);
    assert.ok(headers.Authorization.startsWith("Basic "));

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction("Summary formatting includes live capability data", async () => {
    envManager.set("SEARXNG_URL", "https://test-searx.example.com");

    const mockServer = createMockServer();
    fetchMocker.mock(
      createMockFetch({
        json: {
          autocomplete: "duckduckgo",
          categories: ["general", "it", "science"],
          default_locale: "en",
          default_theme: "simple",
          engines: [
            {
              categories: ["general"],
              enabled: true,
              name: "duckduckgo",
              shortcut: "ddg",
            },
            {
              categories: ["it"],
              enabled: false,
              name: "github",
              shortcut: "gh",
            },
          ],
          instance_name: "Test Instance",
          locales: {
            en: "English",
            fr: "French",
          },
          plugins: [
            { enabled: true, name: "HTTPS rewrite" },
            { enabled: false, name: "Tracker URL remover" },
          ],
          safe_search: 1,
        },
      })
    );

    const result = await getInstanceInfo(mockServer as any);
    assert.ok(result.includes("Instance Name: Test Instance"));
    assert.ok(result.includes("Categories (3): general, it, science"));
    assert.ok(result.includes("Engines: 1 enabled / 2 total"));
    assert.ok(result.includes("Locales Available: 2"));
    assert.ok(result.includes("HTTPS rewrite (enabled)"));
    assert.ok(result.includes("Tracker URL remover (disabled)"));

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction(
    "Engine filtering uses category and excludes disabled engines by default",
    async () => {
      const formatted = formatInstanceInfo(
        {
          categories: ["general", "it"],
          default_locale: "en",
          default_theme: "simple",
          engines: [
            {
              categories: ["it"],
              enabled: true,
              name: "github",
              shortcut: "gh",
            },
            {
              categories: ["it"],
              enabled: false,
              name: "gitlab",
              shortcut: "gl",
            },
            {
              categories: ["general"],
              enabled: true,
              name: "duckduckgo",
              shortcut: "ddg",
            },
          ],
          instance_name: "Test Instance",
          locales: {},
          plugins: [],
          safe_search: 0,
        },
        { includeEngines: true, category: "it" }
      );

      assert.ok(formatted.includes('Matching Engines (1) for category "it":'));
      assert.ok(formatted.includes("- github | shortcut: gh | categories: it | enabled: yes"));
      assert.ok(!formatted.includes("gitlab"));
      assert.ok(!formatted.includes("duckduckgo | shortcut: ddg"));
    },
    results
  );

  await testFunction("Disabled engines are included on request", () => {
    const formatted = formatInstanceInfo(
      {
        categories: ["it"],
        default_locale: "en",
        default_theme: "simple",
        engines: [
          {
            categories: ["it"],
            enabled: false,
            name: "gitlab",
            shortcut: "gl",
          },
        ],
        instance_name: "Test Instance",
        locales: {},
        plugins: [],
        safe_search: 0,
      },
      { includeEngines: true, includeDisabled: true, category: "it" }
    );

    assert.ok(formatted.includes("Matching Engines (1)"));
    assert.ok(formatted.includes("- gitlab | shortcut: gl | categories: it | enabled: no"));
  }, results);

  await testFunction("Invalid config payload shape is rejected", async () => {
    envManager.set("SEARXNG_URL", "https://test-searx.example.com");

    const mockServer = createMockServer();
    fetchMocker.mock(createMockFetch({ json: "not-an-object" }));

    try {
      await fetchInstanceConfig(mockServer as any);
      assert.fail("Should have thrown config shape error");
    } catch (error: any) {
      assert.ok(
        error.message.includes("Config Error") ||
          error.message.includes("response shape")
      );
    }

    fetchMocker.restore();
    envManager.restore();
  }, results);

  printTestSummary(results, "Instance Info Module");
  return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runTests()
    .then((summary) => {
      process.exit(summary.failed > 0 ? 1 : 0);
    })
    .catch(console.error);
}

export { runTests };
