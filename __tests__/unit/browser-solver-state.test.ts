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
  type BrowserSolverAcquisition,
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

function jsonSolution(url: string, extra: Record<string, unknown> = {}) {
  return {
    status: "ok",
    solution: {
      url,
      status: 200,
      cookies: [],
      userAgent: "SolverUA/1.0",
      ...extra,
    },
  };
}

async function waitForPending(
  pending: http.ServerResponse[],
  count: number,
): Promise<void> {
  while (pending.length < count) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

interface SwitchedProviderState {
  flarePending: Promise<BrowserSolverAcquisition>;
  byparrConfig: BrowserSolverConfig;
}

async function saturateFlareThenSwitch(
  target: URL,
  pending: http.ServerResponse[],
  hanging: TestServer,
  responding: TestServer,
): Promise<SwitchedProviderState> {
  process.env.FLARESOLVERR_URL = hanging.url;
  delete process.env.BYPARR_URL;
  process.env.FLARESOLVERR_MAX_CONCURRENT_REQUESTS = "1";
  const flareConfig = resolveBrowserSolverConfig(createMockServer() as any)!;
  const flarePending = acquireBrowserSolverSolution(
    createMockServer() as any,
    flareConfig,
    target,
  );
  await waitForPending(pending, 1);
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
  return { flarePending, byparrConfig };
}

async function assertByparrSaturation(
  target: URL,
  pending: http.ServerResponse[],
  hanging: TestServer,
  byparrConfig: BrowserSolverConfig,
): Promise<void> {
  const byparrHanging = { ...byparrConfig, endpoint: new URL(`${hanging.url}/v1`) };
  const byparrPending = acquireBrowserSolverSolution(
    createMockServer() as any,
    byparrHanging,
    target,
  );
  await waitForPending(pending, 2);
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
}

async function assertProviderCounterIsolation(): Promise<void> {
  const target = new URL("https://example.com/paper");
  const pending: http.ServerResponse[] = [];
  const hanging = await startServer((_req, res) => pending.push(res));
  const responding = await startServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(jsonSolution(target.href)));
  });
  try {
    const { flarePending, byparrConfig } = await saturateFlareThenSwitch(
      target,
      pending,
      hanging,
      responding,
    );
    pending[0].writeHead(200, { "content-type": "application/json" });
    pending[0].end(JSON.stringify(jsonSolution(target.href)));
    assert.equal((await flarePending).kind, "solved");
    await assertByparrSaturation(target, pending, hanging, byparrConfig);
  } finally {
    for (const response of pending) {
      if (!response.writableEnded) {
        response.end();
      }
    }
    await responding.close();
    await hanging.close();
  }
}

async function runTests() {
  console.log("🧪 Testing: browser solver state and replay headers\n");

  await testFunction(
    "provider counters stay independent across environment switches and saturation",
    assertProviderCounterIsolation,
    results,
  );

  await testFunction("solution validation never logs clearance-cookie values", async () => {
    const clearanceValue = ["clearance", "sensitive", "value"].join("-");
    const target = new URL("https://example.com/paper");
    const solver = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(jsonSolution("https://other.example/paper", {
        cookies: [{ name: "cf_clearance", value: clearanceValue }],
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
      assert.ok(!JSON.stringify(getLoggingCalls()).includes(clearanceValue));
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

  printTestSummary(results, "Browser Solver State");
  return results;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  runTests()
    .then((result) => {
      process.exitCode = result.failed > 0 ? 1 : 0;
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}

export { runTests };
