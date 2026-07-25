#!/usr/bin/env tsx

import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { LoggingMessageNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
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
  const logs: unknown[] = [];
  let stderr = "";
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/cli.ts"],
    cwd: process.cwd(),
    env: {
      ...process.env,
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
  client.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => {
    logs.push(notification);
  });
  await client.connect(transport);
  await new Promise((resolve) => setTimeout(resolve, 20));
  return { client, logs, getStderr: () => stderr };
}

async function runTests() {
  console.log("Integration Testing: credential-safe diagnostics\n");

  await testFunction("real CLI startup logging removes URL Basic Auth userinfo", async () => {
    const markerUrl = "https://cli-user:cli-secret@search.example.com/path";
    const { client, logs, getStderr } = await connectCli(markerUrl);
    await client.close();

    const output = `${JSON.stringify(logs)}\n${getStderr()}`;
    assert.ok(!output.includes("cli-user"), output);
    assert.ok(!output.includes("cli-secret"), output);
    assert.ok(output.includes("https://search.example.com/path"), output);
  }, results);

  await testFunction("real CLI JSON-RPC errors remove invalid URL credentials", async () => {
    const markerUrl = "ftp://rpc-user:rpc-secret@search.example.com/path";
    const { client, logs, getStderr } = await connectCli(markerUrl);
    let errorText = "";
    try {
      await client.callTool({
        name: "searxng_web_search",
        arguments: { query: "test" },
      });
      assert.fail("Expected invalid protocol error");
    } catch (error) {
      errorText = error instanceof Error ? `${error.message}\n${error.stack}` : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    await client.close();

    const output = `${errorText}\n${JSON.stringify(logs)}\n${getStderr()}`;
    assert.ok(!output.includes("rpc-user"), output);
    assert.ok(!output.includes("rpc-secret"), output);
    assert.ok(output.includes("ftp:"), output);
    assert.ok(output.includes("search.example.com"), output);
  }, results);

  await testFunction("outbound network failures never echo Basic Auth material", async () => {
    const markerUrl = "http://network-user:network-secret@127.0.0.1:1";
    const { client, logs, getStderr } = await connectCli(markerUrl, {
      FETCH_TIMEOUT_MS: "250",
    });
    let errorText = "";
    try {
      await client.callTool({
        name: "searxng_web_search",
        arguments: { query: "test" },
      });
      assert.fail("Expected network failure");
    } catch (error) {
      errorText = error instanceof Error ? `${error.message}\n${error.stack}` : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    await client.close();

    const output = `${errorText}\n${JSON.stringify(logs)}\n${getStderr()}`;
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
