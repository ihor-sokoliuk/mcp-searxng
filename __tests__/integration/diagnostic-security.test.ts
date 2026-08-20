#!/usr/bin/env tsx

import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  createTestResults,
  printTestSummary,
  testFunction,
} from "../helpers/test-utils.js";

const results = createTestResults();

async function connectCli(
  searxngUrl: string,
  extraEnv: Record<string, string> = {},
) {
  let stderr = "";
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/cli.ts"],
    cwd: process.cwd(),
    env: {
      ...process.env,
      AUTH_USERNAME: "",
      AUTH_PASSWORD: "",
      SEARXNG_URL: searxngUrl,
      ...extraEnv,
    } as Record<string, string>,
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const client = new Client(
    { name: "diagnostic-security-test", version: "1.0.0" },
    { capabilities: {} },
  );
  await client.connect(transport);
  await new Promise((resolve) => setTimeout(resolve, 20));
  return { client, getStderr: () => stderr };
}

async function runTests() {
  console.log("Integration Testing: credential-safe diagnostics\n");

  await testFunction("real CLI startup logging removes URL Basic Auth userinfo", async () => {
    const markerUrl = "https://cli-user:cli-secret@search.example.com/path";
    const { client, getStderr } = await connectCli(markerUrl);
    await client.close();

    const output = getStderr();
    assert.ok(!output.includes("cli-user"), output);
    assert.ok(!output.includes("cli-secret"), output);
    assert.match(getStderr(), /SearXNG URLs: https:\/\/search\.example\.com\/path/, output);
  }, results);

  await testFunction("real CLI JSON-RPC errors remove invalid URL credentials", async () => {
    const markerUrl = "ftp://rpc-user:rpc-secret@search.example.com/path";
    const { client, getStderr } = await connectCli(markerUrl);
    let caught: unknown;
    try {
      await client.callTool({
        name: "searxng_web_search",
        arguments: { query: "test" },
      });
      assert.fail("Expected configuration error");
    } catch (error) {
      caught = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    await client.close();

    const errorText = caught instanceof Error ? `${caught.message}\n${caught.stack}` : String(caught);
    const output = `${errorText}\n${getStderr()}`;
    assert.ok(!output.includes("rpc-user"), output);
    assert.ok(!output.includes("rpc-secret"), output);
    assert.ok(output.includes("ftp:"), output);
    assert.ok(output.includes("Configuration Issues"), output);
  }, results);

  await testFunction("outbound network failures never echo Basic Auth material", async () => {
    const markerUrl = "http://network-user:network-secret@127.0.0.1:1";
    const { client, getStderr } = await connectCli(markerUrl, {
      FETCH_TIMEOUT_MS: "250",
    });
    let caught: unknown;
    try {
      await client.callTool({
        name: "searxng_web_search",
        arguments: { query: "test" },
      });
      assert.fail("Expected network error");
    } catch (error) {
      caught = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    await client.close();

    const errorText = caught instanceof Error ? `${caught.message}\n${caught.stack}` : String(caught);
    const output = `${errorText}\n${getStderr()}`;
    assert.ok(!output.includes("network-user"), output);
    assert.ok(!output.includes("network-secret"), output);
    assert.ok(
      output.includes("Connection") || output.includes("Network"),
      output,
    );
  }, results);

  printTestSummary(results, "Credential-Safe Diagnostics");
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
