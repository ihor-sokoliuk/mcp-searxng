#!/usr/bin/env tsx

import { strict as assert } from "node:assert";
import * as http from "node:http";
import * as net from "node:net";
import { fileURLToPath } from "node:url";
import {
  acquireBrowserSolverSolution,
  buildBrowserSolverHeaders,
  createBrowserSolverCacheKey,
  resolveBrowserSolverConfig,
  type BrowserSolverConfig,
} from "../../src/browser-solver.js";
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
    assert.equal(resolveBrowserSolverConfig(server as any), null);
    process.env.FLARESOLVERR_URL = "   ";
    assert.equal(resolveBrowserSolverConfig(server as any), null);
  }, results);

  await testFunction("configuration normalizes a base path and bounded defaults", () => {
    process.env.FLARESOLVERR_URL = "http://solver.example/base";
    delete process.env.FLARESOLVERR_TIMEOUT_MS;
    delete process.env.FLARESOLVERR_MAX_CONCURRENT_REQUESTS;

    const config = resolveBrowserSolverConfig(createMockServer() as any);
    assert.equal(config?.endpoint.href, "http://solver.example/base/v1");
    assert.equal(config?.timeoutMs, 60000);
    assert.equal(config?.maxConcurrentRequests, 2);

    process.env.FLARESOLVERR_URL = "http://solver.example/base/v1/";
    assert.equal(
      resolveBrowserSolverConfig(createMockServer() as any)?.endpoint.href,
      "http://solver.example/base/v1",
    );
  }, results);

  await testFunction("invalid numeric controls warn and use bounded defaults", async () => {
    process.env.FLARESOLVERR_URL = "http://solver.example";
    process.env.FLARESOLVERR_TIMEOUT_MS = "300001";
    process.env.FLARESOLVERR_MAX_CONCURRENT_REQUESTS = "17";
    const { server, getLoggingCalls } = createMockServerWithTracking();

    const config = resolveBrowserSolverConfig(server as any);
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
      () => resolveBrowserSolverConfig(createMockServer() as any),
      /FLARESOLVERR_URL.*http.*https/iu,
    );

    process.env.FLARESOLVERR_URL = "http://solver.example/path?query=1";
    assert.throws(
      () => resolveBrowserSolverConfig(createMockServer() as any),
      /FLARESOLVERR_URL/u,
    );
  }, results);

  await testFunction("Byparr uses explicit seconds and independent defaults", () => {
    delete process.env.FLARESOLVERR_URL;
    process.env.BYPARR_URL = "http://byparr.example/api";
    delete process.env.BYPARR_TIMEOUT_SECONDS;
    delete process.env.BYPARR_MAX_CONCURRENT_REQUESTS;

    assert.deepEqual(resolveBrowserSolverConfig(createMockServer() as any), {
      provider: "byparr",
      endpoint: new URL("http://byparr.example/api/v1"),
      timeoutMs: 60_000,
      wireTimeout: 60,
      maxConcurrentRequests: 2,
      maxResponseBytes: 5 * 1024 * 1024,
    });

    process.env.BYPARR_TIMEOUT_SECONDS = "300";
    process.env.BYPARR_MAX_CONCURRENT_REQUESTS = "16";
    const bounded = resolveBrowserSolverConfig(createMockServer() as any);
    assert.equal(bounded?.timeoutMs, 300_000);
    assert.equal(bounded?.wireTimeout, 300);
    assert.equal(bounded?.maxConcurrentRequests, 16);
  }, results);

  await testFunction("Byparr invalid numeric controls warn and use defaults", async () => {
    delete process.env.FLARESOLVERR_URL;
    process.env.BYPARR_URL = "http://byparr.example";
    process.env.BYPARR_TIMEOUT_SECONDS = "1.5";
    process.env.BYPARR_MAX_CONCURRENT_REQUESTS = "17";
    const { server, getLoggingCalls } = createMockServerWithTracking();

    const config = resolveBrowserSolverConfig(server as any);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(config?.timeoutMs, 60_000);
    assert.equal(config?.maxConcurrentRequests, 2);
    const diagnostics = JSON.stringify(getLoggingCalls());
    assert.ok(diagnostics.includes("BYPARR_TIMEOUT_SECONDS"));
    assert.ok(diagnostics.includes("BYPARR_MAX_CONCURRENT_REQUESTS"));
    assert.ok(!diagnostics.includes("1.5"));
  }, results);

  await testFunction("both providers and credential-bearing endpoints fail closed without values", () => {
    process.env.FLARESOLVERR_URL = "http://flare-secret.example";
    process.env.BYPARR_URL = "http://byparr-secret.example";
    assert.throws(
      () => resolveBrowserSolverConfig(createMockServer() as any),
      (error: Error) => (
        error.message.includes("Configure only one browser solver")
        && !error.message.includes("flare-secret")
        && !error.message.includes("byparr-secret")
      ),
    );

    delete process.env.FLARESOLVERR_URL;
    process.env.BYPARR_URL = "http://user:password@byparr-secret.example";
    assert.throws(
      () => resolveBrowserSolverConfig(createMockServer() as any),
      (error: Error) => (
        error.message.includes("BYPARR_URL")
        && !error.message.includes("user:password")
        && !error.message.includes("byparr-secret")
      ),
    );
  }, results);

  await testFunction("provider request uses the configured native timeout unit", async () => {
    const target = new URL("https://example.com/paper");
    for (const testCase of [
      { provider: "flaresolverr" as const, wireTimeout: 1250, timeoutMs: 1250 },
      { provider: "byparr" as const, wireTimeout: 7, timeoutMs: 7000 },
    ]) {
      let receivedBody: any;
      const solver = await startServer(async (req, res) => {
        receivedBody = await readJsonBody(req);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(jsonSolution(target.href)));
      });
      try {
        const acquisition = await acquireBrowserSolverSolution(
          createMockServer() as any,
          {
            ...testCase,
            endpoint: new URL(`${solver.url}/v1`),
            maxConcurrentRequests: 2,
            maxResponseBytes: testCase.provider === "byparr"
              ? 5 * 1024 * 1024
              : 256 * 1024,
          },
          target,
        );
        assert.equal(acquisition.kind, "solved");
        assert.equal(receivedBody.maxTimeout, testCase.wireTimeout);
      } finally {
        await solver.close();
      }
    }
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
      const config: BrowserSolverConfig = {
        provider: "flaresolverr",
        endpoint: new URL(`${solver.url}/v1`),
        timeoutMs: 1000,
        wireTimeout: 1000,
        maxConcurrentRequests: 2,
        maxResponseBytes: 256 * 1024,
      };
      const acquisition = await acquireBrowserSolverSolution(
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
      const acquisition = await acquireBrowserSolverSolution(
        createMockServer() as any,
        { provider: "byparr", endpoint: new URL(`${solver.url}/v1`), timeoutMs: 1000, wireTimeout: 1, maxConcurrentRequests: 2, maxResponseBytes: 5 * 1024 * 1024 },
        target,
      );
      assert.equal(acquisition.kind, "solved");
    } finally {
      await solver.close();
    }
  }, results);

  await testFunction("solver response transfer has grace beyond the browser timeout", async () => {
    const target = new URL("https://example.com/paper");
    const solver = await startServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(jsonSolution(target.href)));
      }, 35);
    });

    try {
      const acquisition = await acquireBrowserSolverSolution(
        createMockServer() as any,
        { provider: "flaresolverr", endpoint: new URL(`${solver.url}/v1`), timeoutMs: 20, wireTimeout: 20, maxConcurrentRequests: 2, maxResponseBytes: 256 * 1024 },
        target,
      );
      assert.equal(acquisition.kind, "solved");
    } finally {
      await solver.close();
    }
  }, results);

  await testFunction("persistent solver HTTP 4xx fails closed while transient statuses fall back", async () => {
    const target = new URL("https://example.com/paper");
    for (const status of [400, 404]) {
      const solver = await startServer((_req, res) => {
        res.writeHead(status, { "content-type": "text/plain" });
        res.end("private response detail");
      });
      try {
        await assert.rejects(
          acquireBrowserSolverSolution(
            createMockServer() as any,
            { provider: "flaresolverr", endpoint: new URL(`${solver.url}/v1`), timeoutMs: 1000, wireTimeout: 1000, maxConcurrentRequests: 2, maxResponseBytes: 256 * 1024 },
            target,
          ),
          /Configuration Error.*endpoint rejected/iu,
        );
      } finally {
        await solver.close();
      }
    }

    for (const status of [408, 429, 500]) {
      const solver = await startServer((_req, res) => {
        res.writeHead(status, { "content-type": "text/plain" });
        res.end("transient");
      });
      try {
        assert.deepEqual(
          await acquireBrowserSolverSolution(
            createMockServer() as any,
            { provider: "flaresolverr", endpoint: new URL(`${solver.url}/v1`), timeoutMs: 1000, wireTimeout: 1000, maxConcurrentRequests: 2, maxResponseBytes: 256 * 1024 },
            target,
          ),
          { kind: "fallback", reason: "unavailable" },
        );
      } finally {
        await solver.close();
      }
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
        const acquisition = await acquireBrowserSolverSolution(
          mockServer as any,
          { provider: "flaresolverr", endpoint: new URL(`${solver.url}/v1`), timeoutMs: 1000, wireTimeout: 1000, maxConcurrentRequests: 2, maxResponseBytes: 256 * 1024 },
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
      const acquisition = await acquireBrowserSolverSolution(
        createMockServer() as any,
        { provider: "flaresolverr", endpoint: new URL(`${hanging.url}/v1`), timeoutMs: 25, wireTimeout: 25, maxConcurrentRequests: 2, maxResponseBytes: 256 * 1024 },
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
    const config: BrowserSolverConfig = {
      provider: "flaresolverr",
      endpoint: new URL(`${solver.url}/v1`),
      timeoutMs: 1000,
      wireTimeout: 1000,
      maxConcurrentRequests: 2,
      maxResponseBytes: 256 * 1024,
    };

    try {
      const first = acquireBrowserSolverSolution(createMockServer() as any, config, target);
      const second = acquireBrowserSolverSolution(createMockServer() as any, config, target);
      await ready;
      const third = await acquireBrowserSolverSolution(createMockServer() as any, config, target);
      assert.deepEqual(third, { kind: "fallback", reason: "busy" });

      for (const response of pending) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(jsonSolution(target.href)));
      }
      assert.equal((await first).kind, "solved");
      assert.equal((await second).kind, "solved");

      const fourth = acquireBrowserSolverSolution(createMockServer() as any, config, target);
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

  await testFunction("an oversized Byparr envelope is bounded and falls back", async () => {
    const target = new URL("https://example.com/paper");
    const solver = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(jsonSolution(target.href, {
        response: "x".repeat(5 * 1024 * 1024),
      })));
    });
    try {
      const acquisition = await acquireBrowserSolverSolution(
        createMockServer() as any,
        {
          provider: "byparr",
          endpoint: new URL(`${solver.url}/v1`),
          timeoutMs: 1000,
          wireTimeout: 1,
          maxConcurrentRequests: 2,
          maxResponseBytes: 5 * 1024 * 1024,
        },
        target,
      );
      assert.deepEqual(acquisition, { kind: "fallback", reason: "unavailable" });
    } finally {
      await solver.close();
    }
  }, results);

  await testFunction("cancellation while streaming a solver response never falls back", async () => {
    const target = new URL("https://example.com/paper");
    const solver = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"status":"ok","solution":');
    });
    const controller = new AbortController();
    try {
      const acquisition = acquireBrowserSolverSolution(
        createMockServer() as any,
        {
          provider: "byparr",
          endpoint: new URL(`${solver.url}/v1`),
          timeoutMs: 10_000,
          wireTimeout: 10,
          maxConcurrentRequests: 1,
          maxResponseBytes: 5 * 1024 * 1024,
        },
        target,
        controller.signal,
      );
      await new Promise((resolve) => setTimeout(resolve, 25));
      controller.abort(new DOMException("cancelled stream", "AbortError"));
      await assert.rejects(acquisition, /cancelled stream/u);
    } finally {
      await solver.close();
    }
  }, results);

  await testFunction("cancellation aborts acquisition and releases only that provider slot", async () => {
    const target = new URL("https://example.com/paper");
    const hanging = await startServer(() => {});
    const responding = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(jsonSolution(target.href)));
    });
    const config: BrowserSolverConfig = {
      provider: "flaresolverr",
      endpoint: new URL(`${hanging.url}/v1`),
      timeoutMs: 10_000,
      wireTimeout: 10_000,
      maxConcurrentRequests: 1,
      maxResponseBytes: 256 * 1024,
    };
    const controller = new AbortController();
    try {
      const pending = acquireBrowserSolverSolution(
        createMockServer() as any,
        config,
        target,
        controller.signal,
      );
      await new Promise((resolve) => setTimeout(resolve, 25));
      const started = Date.now();
      controller.abort(new DOMException("cancelled", "AbortError"));
      await assert.rejects(pending, /cancelled/u);
      assert.ok(Date.now() - started < 1000);

      const byparr = await acquireBrowserSolverSolution(
        createMockServer() as any,
        {
          ...config,
          provider: "byparr",
          endpoint: new URL(`${responding.url}/v1`),
          maxResponseBytes: 5 * 1024 * 1024,
          wireTimeout: 10,
        },
        target,
      );
      assert.equal(byparr.kind, "solved");
    } finally {
      await responding.close();
      await hanging.close();
    }
  }, results);

  await testFunction("provider counters stay independent across environment switches and saturation", async () => {
    const target = new URL("https://example.com/paper");
    const pending: http.ServerResponse[] = [];
    const hanging = await startServer((_req, res) => {
      pending.push(res);
    });
    const responding = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(jsonSolution(target.href)));
    });

    try {
      process.env.FLARESOLVERR_URL = hanging.url;
      delete process.env.BYPARR_URL;
      process.env.FLARESOLVERR_MAX_CONCURRENT_REQUESTS = "1";
      const flareConfig = resolveBrowserSolverConfig(createMockServer() as any)!;
      const flarePending = acquireBrowserSolverSolution(
        createMockServer() as any,
        flareConfig,
        target,
      );
      while (pending.length < 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      assert.deepEqual(
        await acquireBrowserSolverSolution(createMockServer() as any, flareConfig, target),
        { kind: "fallback", reason: "busy" },
      );

      delete process.env.FLARESOLVERR_URL;
      process.env.BYPARR_URL = responding.url;
      process.env.BYPARR_MAX_CONCURRENT_REQUESTS = "1";
      const byparrConfig = resolveBrowserSolverConfig(createMockServer() as any)!;
      assert.equal(
        (await acquireBrowserSolverSolution(
          createMockServer() as any,
          byparrConfig,
          target,
        )).kind,
        "solved",
      );

      pending[0].writeHead(200, { "content-type": "application/json" });
      pending[0].end(JSON.stringify(jsonSolution(target.href)));
      assert.equal((await flarePending).kind, "solved");

      const byparrHanging = { ...byparrConfig, endpoint: new URL(`${hanging.url}/v1`) };
      const byparrPending = acquireBrowserSolverSolution(
        createMockServer() as any,
        byparrHanging,
        target,
      );
      while (pending.length < 2) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      assert.deepEqual(
        await acquireBrowserSolverSolution(
          createMockServer() as any,
          byparrHanging,
          target,
        ),
        { kind: "fallback", reason: "busy" },
      );
      pending[1].writeHead(200, { "content-type": "application/json" });
      pending[1].end(JSON.stringify(jsonSolution(target.href)));
      assert.equal((await byparrPending).kind, "solved");
    } finally {
      for (const response of pending) {
        if (!response.writableEnded) {
          response.end();
        }
      }
      await responding.close();
      await hanging.close();
    }
  }, results);

  await testFunction("solution validation never logs clearance-cookie values", async () => {
    const cookieSecret = "clearance-secret-value";
    const target = new URL("https://example.com/paper");
    const solver = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(jsonSolution("https://other.example/paper", {
        cookies: [{ name: "cf_clearance", value: cookieSecret }],
      })));
    });
    const { server, getLoggingCalls } = createMockServerWithTracking();
    try {
      await assert.rejects(
        acquireBrowserSolverSolution(
          server as any,
          {
            provider: "flaresolverr",
            endpoint: new URL(`${solver.url}/v1`),
            timeoutMs: 1000,
            wireTimeout: 1000,
            maxConcurrentRequests: 2,
            maxResponseBytes: 256 * 1024,
          },
          target,
        ),
        /different or unsupported hostname/iu,
      );
      await new Promise((resolve) => setImmediate(resolve));
      assert.ok(!JSON.stringify(getLoggingCalls()).includes(cookieSecret));
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
        { name: "bad\nname", value: "x", domain: ".example.com", path: "/" },
        { name: "bad-value", value: "x;y", domain: ".example.com", path: "/" },
        { name: "oversized", value: "x".repeat(5000), domain: ".example.com", path: "/" },
        { name: "", value: "x", domain: ".example.com", path: "/" },
      ],
    };

    assert.deepEqual(
      buildBrowserSolverHeaders(solution, new URL("https://sub.example.com/a/b"), 2000),
      {
        "User-Agent": "SolverUA/1.0",
        Cookie: "deep=1; domain=2; session=3; secure-http=x",
      },
    );
    assert.deepEqual(
      buildBrowserSolverHeaders(solution, new URL("http://sub.example.com/a/b"), 2000),
      {
        "User-Agent": "SolverUA/1.0",
        Cookie: "session=3",
      },
    );
    assert.deepEqual(
      buildBrowserSolverHeaders(
        { ...solution, cookies: [] },
        new URL("https://sub.example.com/a/b"),
        2000,
      ),
      { "User-Agent": "SolverUA/1.0" },
    );
    assert.deepEqual(
      buildBrowserSolverHeaders(
        solution,
        new URL("https://other.example.com/a/b"),
        2000,
      ),
      { "User-Agent": "SolverUA/1.0" },
    );
  }, results);

  await testFunction("solver cache key uses the original requested URL", () => {
    assert.equal(
      createBrowserSolverCacheKey("flaresolverr", "https://example.com/original"),
      "solver:flaresolverr:https://example.com/original",
    );
  }, results);

  printTestSummary(results, "FlareSolverr Module");
  return results;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  runTests().then((result) => process.exit(result.failed > 0 ? 1 : 0)).catch(console.error);
}

export { runTests };
