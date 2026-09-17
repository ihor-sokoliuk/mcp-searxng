#!/usr/bin/env tsx

import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import http from "node:http";
import net from "node:net";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createHttpServer } from "../../src/http-server.js";
import { createMcpServer, ToolAdmissionController } from "../../src/index.js";
import { resetDiagnosticSanitizerForTests } from "../../src/diagnostic-sanitizer.js";
import { snapshotProcessEnv, restoreProcessEnv } from "../helpers/env-utils.js";
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
  const logs: unknown[] = [];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/cli.ts"],
    cwd: process.cwd(),
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) =>
        !/proxy|^MCP_HTTP_|^FLARESOLVERR_|^BYPARR_|^SEARXNG_FANOUT$/i.test(key))),
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
    { capabilities: { logging: {} } },
  );
  client.setNotificationHandler("notifications/message", (notification) => {
    logs.push(notification);
  });
  await client.connect(transport);
  await new Promise((resolve) => setTimeout(resolve, 20));
  return { client, logs, getStderr: () => stderr };
}

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: http.Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function authenticatedProxyFixture() {
  const requests: Array<{ url: string; headers: http.IncomingHttpHeaders }> = [];
  const auth: string[] = [];
  const sockets = new Set<net.Socket>();
  const secret = randomUUID();
  const content = 'Credential-free fixture content';
  const target = http.createServer((request, response) => {
    requests.push({ url: request.url ?? "", headers: request.headers });
    if (request.url?.startsWith("/redirect")) {
      response.writeHead(302, { location: "/page" });
      response.end();
    } else if (request.url?.startsWith("/search")) {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ results: [{ title: "Fixture", url: "https://example.com/", content }] }));
    } else {
      response.setHeader("Content-Type", "text/html");
      response.end("<p>" + content + "</p>");
    }
  });
  const targetUrl = await listen(target);
  const proxy = http.createServer();
  proxy.on("connect", (request, socket, head) => {
    auth.push(String(request.headers["proxy-authorization"]));
    // Forward exclusively to this test's loopback target, never to caller input.
    const upstream = net.connect(Number(new URL(targetUrl).port), "127.0.0.1", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    for (const connection of [socket, upstream]) {
      sockets.add(connection);
      connection.on("error", () => connection.destroy());
      connection.on("close", () => sockets.delete(connection));
    }
    socket.on("close", () => upstream.destroy());
    upstream.on("close", () => socket.destroy());
  });
  const proxyUrl = await listen(proxy);
  return {
    targetUrl, proxyUrl, requests, auth, content, secret,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await Promise.all([closeServer(proxy), closeServer(target)]);
    },
  };
}

async function withIsolatedEnv(callback: () => Promise<void>): Promise<void> {
  const env = snapshotProcessEnv();
  try {
    await callback();
  } finally {
    restoreProcessEnv(env);
    resetDiagnosticSanitizerForTests();
  }
}

interface ProxyRoutingFixture {
  targetUrl: string;
  auth: string[];
  content: string;
  secret: string;
}

async function verifyBypassAndGlobalProxy(fixture: ProxyRoutingFixture, configured: URL) {
  const authBefore = fixture.auth.length;
  const bypass = await connectCli(fixture.targetUrl, { HTTP_PROXY: configured.href, NO_PROXY: "127.0.0.1" });
  try {
    const result = await bypass.client.callTool({ name: "searxng_web_search", arguments: { query: "bypass" } });
    assert.notEqual(result.isError, true);
    assert.equal(fixture.auth.length, authBefore);
    assert.equal((result.content[0] as { text: string }).text,
      `Title: Fixture\nDescription: ${fixture.content}\nURL: https://example.com/`);
  } finally {
    await bypass.client.close();
  }
  const encodedSecret = `${fixture.secret} p@ss/word?`;
  configured.password = encodedSecret;
  const global = await connectCli(fixture.targetUrl, { HTTP_PROXY: configured.href });
  try {
    const result = await global.client.callTool({ name: "searxng_web_search", arguments: { query: "global" } });
    assert.notEqual(result.isError, true);
    assert.equal(fixture.auth.length, authBefore + 1);
    assert.equal(fixture.auth.at(-1), `Basic ${Buffer.from("proxy-user:" + encodedSecret).toString("base64")}`);
  } finally {
    await global.client.close();
  }
}

async function runTests() {
  console.log("Integration Testing: credential-safe diagnostics\n");

  for (const scenario of ["single", "failover", "fanout", "reader", "flaresolverr", "byparr"]) {
    await testFunction(`proxy errors keep ${scenario} responses and MCP logs credential-free`, async () => {
      const search = ["single", "failover", "fanout"].includes(scenario);
      const multi = scenario === "failover" || scenario === "fanout";
      const unexpected = scenario === "single" || scenario === "flaresolverr" || scenario === "byparr";
      const searxng = multi ? "http://127.0.0.1:1;http://127.0.0.1:2" : "http://127.0.0.1:1";
      const connection = await connectCli(searxng, {
        HTTP_PROXY: "//proxy-user:proxy-secret@proxy.example:8080",
        ...(scenario === "fanout" ? { SEARXNG_FANOUT: "true" } : {}),
        ...(scenario === "flaresolverr" ? { FLARESOLVERR_URL: "http://127.0.0.1:9" } : {}),
        ...(scenario === "byparr" ? { BYPARR_URL: "http://127.0.0.1:9" } : {}),
      });
      try {
        const call = () => connection.client.callTool(search
          ? { name: "searxng_web_search", arguments: { query: "diagnostic test" } }
          : { name: "web_url_read", arguments: { url: "https://example.invalid/" } });
        if (unexpected) {
          await assert.rejects(call, /Internal server error/);
        } else {
          const result = await call();
          assert.equal(result.isError, true);
          assert.match(JSON.stringify(result), /Invalid proxy URL/);
          assert.ok(!JSON.stringify(result).includes("proxy-secret"));
          assert.ok(!JSON.stringify(result).includes("proxy-user"));
        }
        const output = JSON.stringify(connection.logs) + connection.getStderr();
        assert.match(output, /Invalid proxy URL/); // Prove the log sink was exercised.
        assert.ok(!output.includes("proxy-user"), output);
        assert.ok(!output.includes("proxy-secret"), output);
      } finally {
        await connection.client.close();
      }
    }, results);
  }

  await testFunction("proxy redaction preserves authentication, routing, redirects and successful content", async () => {
    const fixture = await authenticatedProxyFixture();
    const configured = new URL(fixture.proxyUrl);
    configured.username = "proxy-user";
    configured.password = fixture.secret;
    const expectedAuth = `Basic ${Buffer.from("proxy-user:" + fixture.secret).toString("base64")}`;
    try {
      // A malformed global setting must not override the valid per-tool route.
      const connection = await connectCli(fixture.targetUrl, {
        HTTP_PROXY: "//unused-user:unused-secret@invalid.example:9",
        SEARCH_HTTP_PROXY: configured.href,
        URL_READER_HTTP_PROXY: configured.href,
        MCP_HTTP_ALLOW_PRIVATE_URLS: "true",
      });
      try {
        const search = await connection.client.callTool({ name: "searxng_web_search", arguments: { query: "fixture" } });
        assert.notEqual(search.isError, true);
        assert.equal((search.content[0] as { text: string }).text,
          `Title: Fixture\nDescription: ${fixture.content}\nURL: https://example.com/`);
        const reader = await connection.client.callTool({ name: "web_url_read", arguments: { url: fixture.targetUrl + "/redirect" } });
        assert.notEqual(reader.isError, true);
        assert.equal((reader.content[0] as { text: string }).text, fixture.content);
        assert.ok(fixture.auth.length >= 3);
        assert.ok(fixture.auth.every(value => value === expectedAuth));
        assert.ok(fixture.requests.some(request => request.url === "/redirect"));
        assert.ok(fixture.requests.some(request => request.url === "/page"));
        assert.equal(fixture.requests.filter(request => request.url.startsWith("/search?")).length, 1);
        assert.equal(fixture.requests.filter(request => request.url === "/redirect").length, 2);
        assert.equal(fixture.requests.filter(request => request.url === "/page").length, 2);
        assert.ok(fixture.requests.every(request => request.headers["proxy-authorization"] === undefined));
      } finally {
        await connection.client.close();
      }
      await verifyBypassAndGlobalProxy(fixture, configured);
    } finally {
      await fixture.close();
    }
  }, results);

  await testFunction("loopback HTTP errors and MCP notifications redact malformed proxy credentials", () => withIsolatedEnv(async () => {
    for (const key of Object.keys(process.env).filter(key =>
      /proxy|^MCP_HTTP_|^FLARESOLVERR_|^BYPARR_|^AUTH_|^SEARXNG_FANOUT$/i.test(key))) {
      delete process.env[key];
    }
    process.env.SEARXNG_URL = "http://127.0.0.1:1";
    process.env.HTTP_PROXY = "http//http-proxy-user:http-proxy-secret@proxy.example:8080";
    resetDiagnosticSanitizerForTests();
    const app = await createHttpServer((modern) => createMcpServer(new ToolAdmissionController({
      rateWindowMs: 60_000, rateMax: 100, maxInFlight: 4,
    }), modern));
    const server = http.createServer(app);
    const base = await listen(server);
    const client = new Client({ name: "proxy-http-test", version: "1.0.0" }, { capabilities: { logging: {} } });
    const logs: unknown[] = [];
    client.setNotificationHandler("notifications/message", notification => { logs.push(notification); });
    const transport = new StreamableHTTPClientTransport(new URL(base + "/mcp"), {
      requestInit: { headers: { Host: "127.0.0.1" } },
    });
    try {
      await client.connect(transport);
      await assert.rejects(() => client.callTool({ name: "searxng_web_search", arguments: { query: "http diagnostic" } }), /Internal server error/);
      const result = await client.callTool({ name: "web_url_read", arguments: { url: "https://example.invalid/" } });
      assert.equal(result.isError, true);
      const output = JSON.stringify({ result, logs });
      assert.match(JSON.stringify(logs), /Invalid proxy URL/);
      assert.ok(!output.includes("http-proxy-user"), output);
      assert.ok(!output.includes("http-proxy-secret"), output);
      await transport.terminateSession();
    } finally {
      await client.close();
      await closeServer(server);
      resetDiagnosticSanitizerForTests();
    }
  }), results);

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
    let resultText = "";
    try {
      const result = await client.callTool({
        name: "searxng_web_search",
        arguments: { query: "test" },
      });
      assert.equal(result.isError, true);
      resultText = (result.content[0] as { type: string; text: string }).text;
    } finally {
      await new Promise((resolve) => setTimeout(resolve, 20));
      await client.close();
    }

    const output = `${resultText}\n${getStderr()}`;
    assert.ok(!output.includes("rpc-user"), output);
    assert.ok(!output.includes("rpc-secret"), output);
    assert.ok(output.includes("unsupported protocol"), output);
    assert.ok(output.includes("Configuration Issues"), output);
  }, results);

  await testFunction("outbound network failures never echo Basic Auth material", async () => {
    const markerUrl = "http://network-user:network-secret@127.0.0.1:1";
    const { client, getStderr } = await connectCli(markerUrl, {
      FETCH_TIMEOUT_MS: "250",
    });
    let resultText = "";
    try {
      const result = await client.callTool({
        name: "searxng_web_search",
        arguments: { query: "test" },
      });
      assert.equal(result.isError, true);
      resultText = (result.content[0] as { type: string; text: string }).text;
    } finally {
      await new Promise((resolve) => setTimeout(resolve, 20));
      await client.close();
    }

    const output = `${resultText}\n${getStderr()}`;
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
