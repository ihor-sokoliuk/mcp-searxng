#!/usr/bin/env tsx

import { strict as assert } from "node:assert";
import * as http from "node:http";
import * as net from "node:net";
import { fileURLToPath } from "node:url";
import {
  acquireFlareSolverrSolution,
  buildFlareSolverrHeaders,
  createFlareSolverrCacheKey,
  resolveFlareSolverrConfig,
  type FlareSolverrConfig,
} from "../../src/flaresolverr.js";
import { createMockServer, createMockServerWithTracking } from "../helpers/mock-server.js";
import { createTestResults, printTestSummary, testFunction } from "../helpers/test-utils.js";

const results = createTestResults();

interface TestServer {
  url: string;
  close: () => Promise<void>;
}

function startServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<TestServer> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as net.AddressInfo;
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise<void>((done) => {
          server.closeAllConnections();
          server.close(() => done());
        }),
      });
    });
    server.once("error", reject);
  });
}

async function readJsonBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function jsonSolution(url: string, extra: Record<string, unknown> = {}) {
  return {
    status: "ok",
    message: "Challenge solved!",
    solution: {
      url,
      status: 200,
      cookies: [{
        name: "clearance",
        value: "abc",
        domain: ".example.com",
        path: "/",
        secure: true,
        expires: 4102444800,
      }],
      userAgent: "SolverUA/1.0",
      ...extra,
    },
  };
}

async function runTests() {
  console.log("🧪 Testing: flaresolverr.ts\n");

  await testFunction("unset and blank FLARESOLVERR_URL disable the solver", () => {
    const server = createMockServer();
    delete process.env.FLARESOLVERR_URL;
    assert.equal(resolveFlareSolverrConfig(server as any), null);
    process.env.FLARESOLVERR_URL = "   ";
    assert.equal(resolveFlareSolverrConfig(server as any), null);
  }, results);

  await testFunction("configuration normalizes a base path and bounded defaults", () => {
    process.env.FLARESOLVERR_URL = "http://solver.example/base";
    delete process.env.FLARESOLVERR_TIMEOUT_MS;
    delete process.env.FLARESOLVERR_MAX_CONCURRENT_REQUESTS;

    const config = resolveFlareSolverrConfig(createMockServer() as any);
    assert.equal(config?.endpoint.href, "http://solver.example/base/v1");
    assert.equal(config?.timeoutMs, 60000);
    assert.equal(config?.maxConcurrentRequests, 2);
  }, results);

  await testFunction("invalid numeric controls warn and use bounded defaults", async () => {
    process.env.FLARESOLVERR_URL = "http://solver.example";
    process.env.FLARESOLVERR_TIMEOUT_MS = "300001";
    process.env.FLARESOLVERR_MAX_CONCURRENT_REQUESTS = "17";
    const { server, getLoggingCalls } = createMockServerWithTracking();

    const config = resolveFlareSolverrConfig(server as any);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(config?.timeoutMs, 60000);
    assert.equal(config?.maxConcurrentRequests, 2);
    const messages = getLoggingCalls().map((entry) => entry.data?.message ?? "");
    assert.equal(messages.filter((message) => message.includes("FLARESOLVERR_")).length, 2);
    assert.ok(messages.every((message) => !message.includes("300001") && !message.includes("17")));
  }, results);

  await testFunction("invalid FLARESOLVERR_URL fails closed", () => {
    process.env.FLARESOLVERR_URL = "file:///tmp/solver";
    assert.throws(
      () => resolveFlareSolverrConfig(createMockServer() as any),
      /FLARESOLVERR_URL.*http.*https/iu,
    );

    process.env.FLARESOLVERR_URL = "http://solver.example/path?query=1";
    assert.throws(
      () => resolveFlareSolverrConfig(createMockServer() as any),
      /FLARESOLVERR_URL/u,
    );
  }, results);

  await testFunction("solver request uses the shared cookie-only API contract", async () => {
    let receivedPath = "";
    let receivedBody: any;
    const target = new URL("https://example.com/paper");
    const solver = await startServer(async (req, res) => {
      receivedPath = req.url ?? "";
      receivedBody = await readJsonBody(req);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(jsonSolution(target.href)));
    });

    try {
      const config: FlareSolverrConfig = {
        endpoint: new URL(`${solver.url}/v1`),
        timeoutMs: 1000,
        maxConcurrentRequests: 2,
      };
      const acquisition = await acquireFlareSolverrSolution(
        createMockServer() as any,
        config,
        target,
      );

      assert.equal(receivedPath, "/v1");
      assert.deepEqual(receivedBody, {
        cmd: "request.get",
        url: target.href,
        maxTimeout: 1000,
        returnOnlyCookies: true,
      });
      assert.equal(acquisition.kind, "solved");
      if (acquisition.kind === "solved") {
        assert.equal(acquisition.solution.userAgent, "SolverUA/1.0");
        assert.equal(acquisition.solution.cookies.length, 1);
      }
    } finally {
      await solver.close();
    }
  }, results);

  await testFunction("small Byparr-style extra response fields are ignored", async () => {
    const target = new URL("https://example.com/paper");
    const solver = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(jsonSolution(target.href, { response: "<html>ignored</html>" })));
    });

    try {
      const acquisition = await acquireFlareSolverrSolution(
        createMockServer() as any,
        { endpoint: new URL(`${solver.url}/v1`), timeoutMs: 1000, maxConcurrentRequests: 2 },
        target,
      );
      assert.equal(acquisition.kind, "solved");
    } finally {
      await solver.close();
    }
  }, results);

  await testFunction("oversized, malformed, top-level error, and timed-out responses fall back", async () => {
    const target = new URL("https://example.com/paper");
    const cases = [
      "x".repeat(262145),
      "{not-json",
      JSON.stringify({ status: "error", message: "private solver detail" }),
    ];

    for (const body of cases) {
      const { server: mockServer, getLoggingCalls } = createMockServerWithTracking();
      const solver = await startServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(body);
      });
      try {
        const acquisition = await acquireFlareSolverrSolution(
          mockServer as any,
          { endpoint: new URL(`${solver.url}/v1`), timeoutMs: 1000, maxConcurrentRequests: 2 },
          target,
        );
        assert.deepEqual(acquisition, { kind: "fallback", reason: "unavailable" });
        await new Promise((resolve) => setImmediate(resolve));
        assert.ok(JSON.stringify(getLoggingCalls()).includes("direct"));
        assert.ok(!JSON.stringify(getLoggingCalls()).includes("private solver detail"));
      } finally {
        await solver.close();
      }
    }

    const hanging = await startServer(() => {});
    try {
      const acquisition = await acquireFlareSolverrSolution(
        createMockServer() as any,
        { endpoint: new URL(`${hanging.url}/v1`), timeoutMs: 25, maxConcurrentRequests: 2 },
        target,
      );
      assert.deepEqual(acquisition, { kind: "fallback", reason: "unavailable" });
    } finally {
      await hanging.close();
    }
  }, results);

  await testFunction("concurrency saturation falls back and releases slots", async () => {
    const target = new URL("https://example.com/paper");
    const pending: http.ServerResponse[] = [];
    let releaseReady!: () => void;
    const ready = new Promise<void>((resolve) => { releaseReady = resolve; });
    const solver = await startServer((_req, res) => {
      pending.push(res);
      if (pending.length === 2) releaseReady();
    });
    const config: FlareSolverrConfig = {
      endpoint: new URL(`${solver.url}/v1`),
      timeoutMs: 1000,
      maxConcurrentRequests: 2,
    };

    try {
      const first = acquireFlareSolverrSolution(createMockServer() as any, config, target);
      const second = acquireFlareSolverrSolution(createMockServer() as any, config, target);
      await ready;
      const third = await acquireFlareSolverrSolution(createMockServer() as any, config, target);
      assert.deepEqual(third, { kind: "fallback", reason: "busy" });

      for (const response of pending) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(jsonSolution(target.href)));
      }
      assert.equal((await first).kind, "solved");
      assert.equal((await second).kind, "solved");

      const fourth = acquireFlareSolverrSolution(createMockServer() as any, config, target);
      while (pending.length < 3) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      pending[2].writeHead(200, { "content-type": "application/json" });
      pending[2].end(JSON.stringify(jsonSolution(target.href)));
      assert.equal((await fourth).kind, "solved");
    } finally {
      await solver.close();
    }
  }, results);

  await testFunction("cookie scope, expiry, security, and path specificity are enforced", () => {
    const solution = {
      url: "https://sub.example.com/a/b",
      status: 200,
      userAgent: "SolverUA/1.0",
      cookies: [
        { name: "domain", value: "2", domain: ".example.com", path: "/", secure: true, expires: 4102444800 },
        { name: "deep", value: "1", domain: "sub.example.com", path: "/a", secure: true, expires: 4102444800 },
        { name: "session", value: "3", path: "/", secure: false, expires: -1 },
        { name: "expired", value: "x", domain: ".example.com", path: "/", expires: 1000 },
        { name: "wrong-domain", value: "x", domain: ".other.example", path: "/" },
        { name: "wrong-path", value: "x", domain: ".example.com", path: "/other" },
        { name: "secure-http", value: "x", domain: ".example.com", path: "/", secure: true },
        { name: "", value: "x", domain: ".example.com", path: "/" },
      ],
    };

    assert.deepEqual(
      buildFlareSolverrHeaders(solution, new URL("https://sub.example.com/a/b"), 2000),
      {
        "User-Agent": "SolverUA/1.0",
        Cookie: "deep=1; domain=2; session=3; secure-http=x",
      },
    );
    assert.deepEqual(
      buildFlareSolverrHeaders(solution, new URL("http://sub.example.com/a/b"), 2000),
      {
        "User-Agent": "SolverUA/1.0",
        Cookie: "session=3",
      },
    );
    assert.deepEqual(
      buildFlareSolverrHeaders(
        { ...solution, cookies: [] },
        new URL("https://sub.example.com/a/b"),
        2000,
      ),
      { "User-Agent": "SolverUA/1.0" },
    );
  }, results);

  await testFunction("solver cache key uses the original requested URL", () => {
    assert.equal(
      createFlareSolverrCacheKey("https://example.com/original"),
      "solver:https://example.com/original",
    );
  }, results);

  printTestSummary(results, "FlareSolverr Module");
  return results;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  runTests().then((result) => process.exit(result.failed > 0 ? 1 : 0)).catch(console.error);
}

export { runTests };
