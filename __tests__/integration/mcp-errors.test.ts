import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { createMcpServer, ToolAdmissionController } from "../../src/index.js";
import { createHttpServer } from "../../src/http-server.js";
import { createUnexpectedError } from "../../src/error-handler.js";
import { FetchMocker, createMockFetch } from "../helpers/mock-fetch.js";
import { createTestResults, printTestSummary, testFunction } from "../helpers/test-utils.js";

type WireResult = { id: number; error?: { code: number; message: string; data?: unknown }; result?: { isError?: boolean; content?: unknown[] } };

async function connectHttp(modern: boolean, controller = new ToolAdmissionController({ rateWindowMs: 60000, rateMax: 100, maxInFlight: 4 })) {
  for (const name of Object.keys(process.env)) if (name.startsWith("MCP_HTTP_")) delete process.env[name];
  process.env.SEARXNG_URL = "https://test-searx.example.com";
  const app = await createHttpServer(era => createMcpServer(controller, era));
  let session: string | undefined;
  let id = 0;
  const output: string[] = [];
  if (!modern) {
    const initialized = await request(app).post("/mcp").set("Accept", "application/json, text/event-stream")
      .send({ jsonrpc: "2.0", id: ++id, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "error-test", version: "1" } } });
    assert.equal(initialized.status, 200, initialized.text);
    session = initialized.headers["mcp-session-id"];
  }
  return {
    output,
    async call(method: string, params: Record<string, unknown>): Promise<WireResult> {
      const callId = ++id;
      const pending = request(app).post("/mcp").set("Accept", modern ? "application/json" : "application/json, text/event-stream");
      if (session) pending.set("mcp-session-id", session);
      if (modern) {
        pending.set("MCP-Protocol-Version", "2026-07-28").set("MCP-Method", method);
        const name = params.name ?? params.uri;
        if (typeof name === "string") pending.set("MCP-Name", name);
        params = { ...params, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} } };
      }
      const response = await pending.send({ jsonrpc: "2.0", id: callId, method, params });
      output.push(response.text);
      if (response.body?.id === callId) return response.body;
      const messages = response.text.split(/\r?\n/).filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)) as WireResult);
      const result = messages.find(message => message.id === callId);
      assert.ok(result, response.text);
      return result;
    },
    async close() {
      if (session) await request(app).delete("/mcp").set("mcp-session-id", session);
    },
  };
}

export async function runTests() {
  const results = createTestResults();
  for (const modern of [false, true]) {
    const era = modern ? "modern" : "legacy";
    await testFunction(`${era} unknown tools/resources and invalid input return invalid params before upstream work`, async () => {
      const wire = await connectHttp(modern);
      const mocker = new FetchMocker();
      let calls = 0;
      mocker.mock(async () => { calls++; throw new Error("Invalid requests must not fetch"); });
      try {
        for (const [method, params] of [
          ["tools/call", { name: "missing-tool", arguments: {} }],
          ["tools/call", { name: "searxng_web_search", arguments: { query: 17 } }],
          ["tools/call", { name: "web_url_read", arguments: {} }],
          ["resources/read", { uri: "https://synthetic-user:synthetic-secret@resource.example.com" }],
        ] as const) {
          const response = await wire.call(method, params);
          assert.equal(response.error?.code, -32602, JSON.stringify(response));
          assert.equal(response.result, undefined);
        }
        assert.equal(calls, 0);
        assert.ok(!wire.output.join("\n").includes("synthetic-secret"));
        assert.ok(!wire.output.join("\n").includes("synthetic-user"));
      } finally {
        mocker.restore();
        await wire.close();
      }
    }, results);
    await testFunction(`${era} expected upstream and URL-policy failures return isError tool results`, async () => {
      const wire = await connectHttp(modern);
      const mocker = new FetchMocker();
      mocker.mock(createMockFetch({ status: 503, ok: false, statusText: "Unavailable", body: "Temporarily unavailable" }));
      try {
        for (const params of [
          { name: "searxng_web_search", arguments: { query: "expected failure" } },
          { name: "web_url_read", arguments: { url: "http://127.0.0.1/private" } },
        ]) {
          const response = await wire.call("tools/call", params);
          assert.equal(response.error, undefined, JSON.stringify(response));
          assert.equal(response.result?.isError, true, JSON.stringify(response));
          assert.ok(response.result?.content?.length);
        }
      } finally {
        mocker.restore();
        await wire.close();
      }
    }, results);
    for (const wrapped of [false, true]) {
      await testFunction(`${era} ${wrapped ? "wrapped" : "raw"} unexpected faults use generic internal errors without details`, async () => {
        const controller = new ToolAdmissionController({ rateWindowMs: 60000, rateMax: 100, maxInFlight: 4 });
        controller.admit = () => {
          const fault = new TypeError("synthetic-internal-sensitive-detail");
          throw wrapped ? createUnexpectedError(fault, {}) : fault;
        };
        const wire = await connectHttp(modern, controller);
        try {
          const response = await wire.call("tools/call", { name: "searxng_web_search", arguments: { query: "internal fault" } });
          assert.deepEqual(response.error, { code: -32603, message: "Internal server error" });
          assert.equal(response.result, undefined);
          assert.ok(!wire.output.join("\n").includes("synthetic-internal-sensitive-detail"));
          assert.ok(!wire.output.join("\n").includes("TypeError"));
        } finally {
          await wire.close();
        }
      }, results);
    }
  }
  printTestSummary(results, "MCP error classification");
  return results;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) runTests().then(result => process.exit(result.failed ? 1 : 0));
