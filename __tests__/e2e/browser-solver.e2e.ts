#!/usr/bin/env tsx

/**
 * E2E Tests: browser-solver-backed web_url_read through the built MCP STDIO
 * transport. The deterministic local test always runs. The real protected-PDF
 * test runs when either provider endpoint points at an available service, or
 * both verification endpoints are supplied for the fail-closed matrix mode.
 */

import { strict as assert } from 'node:assert';
import http from 'node:http';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import {
  checkSkipConditions,
  INIT_PARAMS,
  spawnWithMessagesAsync,
} from './helpers/spawn-server.js';
import { testFunction, createTestResults, printTestSummary } from '../helpers/test-utils.js';
import { createTextPdf } from '../helpers/pdf-fixtures.js';

const results = createTestResults();
const PROTECTED_PDF_URL = 'https://eprint.iacr.org/2025/858.pdf';

interface TestServer {
  url: string;
  close: () => Promise<void>;
}

function startServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<TestServer> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as net.AddressInfo;
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise<void>((done) => {
          server.closeAllConnections();
          server.close(() => done());
        }),
      });
    });
    server.once('error', reject);
  });
}

function readUrlMessages(url: string): object[] {
  return [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: INIT_PARAMS },
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'web_url_read',
        arguments: { url },
      },
    },
  ];
}

async function runTests() {
  console.log('🌐 E2E Testing: FlareSolverr URL reader\n');

  const skip = checkSkipConditions(false);
  if (skip) {
    console.log(skip);
    return { passed: 0, failed: 0, errors: [] };
  }

  await testFunction('built MCP server replays a solved browser session', async () => {
    let replayUserAgent = '';
    let replayCookie = '';
    let byparrRequests = 0;
    const target = await startServer((req, res) => {
      if (req.method === 'GET') {
        replayUserAgent = req.headers['user-agent'] ?? '';
        replayCookie = req.headers.cookie ?? '';
      }
      res.writeHead(req.method === 'HEAD' ? 403 : 200, {
        'content-type': 'application/pdf',
      });
      res.end(req.method === 'HEAD' ? '' : Buffer.from(createTextPdf(['Solver PDF E2E'])));
    });
    const solver = await startServer((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        const request = JSON.parse(body) as { url: string };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          status: 'ok',
          solution: {
            url: request.url,
            status: 200,
            cookies: [{
              name: 'cf_clearance',
              value: 'e2e-token',
              domain: '127.0.0.1',
              path: '/',
            }],
            userAgent: 'flaresolverr-e2e-agent',
          },
        }));
      });
    });
    const byparr = await startServer((req, res) => {
      byparrRequests++;
      req.resume();
      res.writeHead(503);
      res.end();
    });

    try {
      const responses = await spawnWithMessagesAsync(
        readUrlMessages(target.url),
        'https://test-searx.example.com',
        15_000,
        {
          FLARESOLVERR_URL: solver.url,
          BYPARR_URL: byparr.url,
          MCP_HTTP_ALLOW_PRIVATE_URLS: 'true',
          NO_PROXY: '127.0.0.1',
        },
      );
      const response = responses[2];
      assert.ok(response && !response.error, JSON.stringify(response?.error));
      const text: string = response.result?.content?.[0]?.text ?? '';
      assert.ok(text.includes('Solver PDF E2E'), text);
      assert.equal(replayUserAgent, 'flaresolverr-e2e-agent');
      assert.equal(replayCookie, 'cf_clearance=e2e-token');
      assert.equal(byparrRequests, 0);
    } finally {
      await byparr.close();
      await solver.close();
      await target.close();
    }
  }, results);

  await testFunction('built MCP server uses Byparr seconds and replays its session', async () => {
    let replayUserAgent = '';
    const target = await startServer((req, res) => {
      if (req.method === 'GET') {
        replayUserAgent = req.headers['user-agent'] ?? '';
      }
      res.writeHead(req.method === 'HEAD' ? 403 : 200, {
        'content-type': 'text/html',
      });
      res.end(req.method === 'HEAD' ? '' : '<main>Byparr E2E</main>');
    });
    const solver = await startServer((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        const request = JSON.parse(body) as { url: string; maxTimeout: number };
        assert.equal(request.maxTimeout, 60);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          status: 'ok',
          solution: {
            url: request.url,
            status: 200,
            cookies: [],
            userAgent: 'byparr-e2e-agent',
            response: '<html>ignored</html>',
          },
        }));
      });
    });

    try {
      const responses = await spawnWithMessagesAsync(
        readUrlMessages(target.url),
        'https://test-searx.example.com',
        15_000,
        {
          FLARESOLVERR_URL: undefined,
          BYPARR_URL: solver.url,
          MCP_HTTP_ALLOW_PRIVATE_URLS: 'true',
          NO_PROXY: '127.0.0.1',
        },
      );
      const response = responses[2];
      assert.ok(response && !response.error, JSON.stringify(response?.error));
      const text: string = response.result?.content?.[0]?.text ?? '';
      assert.ok(text.includes('Byparr E2E'), text);
      assert.equal(replayUserAgent, 'byparr-e2e-agent');
    } finally {
      await solver.close();
      await target.close();
    }
  }, results);

  await testFunction('built MCP server fails over from FlareSolverr to Byparr', async () => {
    const solverOrder: string[] = [];
    let replayUserAgent = '';
    const target = await startServer((req, res) => {
      if (req.method === 'GET') {
        replayUserAgent = req.headers['user-agent'] ?? '';
      }
      res.writeHead(req.method === 'HEAD' ? 403 : 200, {
        'content-type': 'text/html',
      });
      res.end(req.method === 'HEAD' ? '' : '<main>Dual provider E2E</main>');
    });
    const flare = await startServer((req, res) => {
      solverOrder.push('flaresolverr');
      req.resume();
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'error' }));
    });
    const byparr = await startServer((req, res) => {
      solverOrder.push('byparr');
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        const request = JSON.parse(body) as { url: string; maxTimeout: number };
        assert.equal(request.maxTimeout, 60);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          status: 'ok',
          solution: {
            url: request.url,
            status: 200,
            cookies: [],
            userAgent: 'byparr-failover-e2e-agent',
          },
        }));
      });
    });
    try {
      const responses = await spawnWithMessagesAsync(
        readUrlMessages(target.url),
        'https://test-searx.example.com',
        15_000,
        {
          FLARESOLVERR_URL: flare.url,
          BYPARR_URL: byparr.url,
          MCP_HTTP_ALLOW_PRIVATE_URLS: 'true',
          NO_PROXY: '127.0.0.1',
        },
      );
      const response = responses[2];
      assert.ok(response && !response.error, JSON.stringify(response?.error));
      const text: string = response.result?.content?.[0]?.text ?? '';
      assert.ok(text.includes('Dual provider E2E'), text);
      assert.deepEqual(solverOrder, ['flaresolverr', 'byparr']);
      assert.equal(replayUserAgent, 'byparr-failover-e2e-agent');
    } finally {
      await byparr.close();
      await flare.close();
      await target.close();
    }
  }, results);

  await testFunction('built MCP server performs one direct fetch after both providers fail', async () => {
    const solverOrder: string[] = [];
    let targetGets = 0;
    const target = await startServer((req, res) => {
      if (req.method === 'GET') {
        targetGets++;
      }
      res.writeHead(req.method === 'HEAD' ? 403 : 200, {
        'content-type': 'text/html',
      });
      res.end(req.method === 'HEAD' ? '' : '<main>Direct after dual failure</main>');
    });
    const flare = await startServer((req, res) => {
      solverOrder.push('flaresolverr');
      req.resume();
      res.writeHead(503);
      res.end();
    });
    const byparr = await startServer((req, res) => {
      solverOrder.push('byparr');
      req.resume();
      res.writeHead(429);
      res.end();
    });

    try {
      const responses = await spawnWithMessagesAsync(
        readUrlMessages(target.url),
        'https://test-searx.example.com',
        15_000,
        {
          FLARESOLVERR_URL: flare.url,
          BYPARR_URL: byparr.url,
          MCP_HTTP_ALLOW_PRIVATE_URLS: 'true',
          NO_PROXY: '127.0.0.1',
        },
      );
      const response = responses[2];
      assert.ok(response && !response.error, JSON.stringify(response?.error));
      const text: string = response.result?.content?.[0]?.text ?? '';
      assert.ok(text.includes('Direct after dual failure'), text);
      assert.deepEqual(solverOrder, ['flaresolverr', 'byparr']);
      assert.equal(targetGets, 1);
    } finally {
      await byparr.close();
      await flare.close();
      await target.close();
    }
  }, results);

  const matrixRequested = process.env.BROWSER_SOLVER_REAL_MATRIX === 'true';
  const failoverRequested = process.env.BROWSER_SOLVER_REAL_FAILOVER === 'true';
  if (matrixRequested && failoverRequested) {
    await testFunction('real browser-solver modes are unambiguous', () => {
      assert.fail(
        'BROWSER_SOLVER_REAL_MATRIX and BROWSER_SOLVER_REAL_FAILOVER cannot both be true',
      );
    }, results);
  }
  const realProviders = matrixRequested
    ? [
        {
          name: 'FlareSolverr',
          endpoint: process.env.VERIFY_FLARESOLVERR_URL,
          environment: 'FLARESOLVERR_URL' as const,
        },
        {
          name: 'Byparr',
          endpoint: process.env.VERIFY_BYPARR_URL,
          environment: 'BYPARR_URL' as const,
        },
      ]
    : [
        ...(process.env.FLARESOLVERR_URL
          ? [{
              name: 'FlareSolverr',
              endpoint: process.env.FLARESOLVERR_URL,
              environment: 'FLARESOLVERR_URL' as const,
            }]
          : []),
        ...(process.env.BYPARR_URL
          ? [{
              name: 'Byparr',
              endpoint: process.env.BYPARR_URL,
              environment: 'BYPARR_URL' as const,
            }]
          : []),
      ];

  if (failoverRequested) {
    const flareEndpoint = process.env.VERIFY_FLARESOLVERR_URL;
    const byparrEndpoint = process.env.VERIFY_BYPARR_URL;
    if (!flareEndpoint || !byparrEndpoint) {
      await testFunction('real browser-solver failover has both provider endpoints', () => {
        assert.fail(
          'BROWSER_SOLVER_REAL_FAILOVER=true requires VERIFY_FLARESOLVERR_URL and VERIFY_BYPARR_URL',
        );
      }, results);
    } else {
      await testFunction(
        'real protected PDF fails over from unavailable FlareSolverr to Byparr',
        async () => {
          let primaryReachable = false;
          try {
            await fetch(new URL('/v1', flareEndpoint), {
              method: 'GET',
              signal: AbortSignal.timeout(1000),
            });
            primaryReachable = true;
          } catch {
            // The failover gate deliberately leaves the primary endpoint unavailable.
          }
          assert.equal(primaryReachable, false, 'FlareSolverr endpoint must be unavailable');

          const challenge = await fetch(PROTECTED_PDF_URL, {
            method: 'HEAD',
            redirect: 'manual',
            signal: AbortSignal.timeout(15_000),
          });
          assert.equal(challenge.status, 403);
          assert.equal(challenge.headers.get('cf-mitigated'), 'challenge');

          const responses = await spawnWithMessagesAsync(
            readUrlMessages(PROTECTED_PDF_URL),
            'https://test-searx.example.com',
            90_000,
            {
              FLARESOLVERR_URL: flareEndpoint,
              BYPARR_URL: byparrEndpoint,
              FLARESOLVERR_TIMEOUT_MS: '1000',
            },
          );
          const response = responses[2];
          assert.ok(response && !response.error, JSON.stringify(response?.error));
          const text: string = response.result?.content?.[0]?.text ?? '';
          assert.ok(text.includes('Encrypted Matrix-Vector Products'), text);
          assert.ok(text.includes('Abstract'), text);
          assert.ok(!text.includes('Unsupported content type'), text);
        },
        results,
      );
    }
  } else if (matrixRequested && realProviders.some(({ endpoint }) => !endpoint)) {
    await testFunction('real browser-solver matrix has both provider endpoints', () => {
      assert.fail(
        'BROWSER_SOLVER_REAL_MATRIX=true requires VERIFY_FLARESOLVERR_URL and VERIFY_BYPARR_URL',
      );
    }, results);
  } else if (realProviders.length > 0) {
    for (const provider of realProviders) {
      await testFunction(`real Cloudflare-protected PDF is extracted through ${provider.name}`, async () => {
        const responses = await spawnWithMessagesAsync(
          readUrlMessages(PROTECTED_PDF_URL),
          'https://test-searx.example.com',
          90_000,
          {
            FLARESOLVERR_URL: provider.environment === 'FLARESOLVERR_URL'
              ? provider.endpoint
              : undefined,
            BYPARR_URL: provider.environment === 'BYPARR_URL'
              ? provider.endpoint
              : undefined,
          },
        );
        const response = responses[2];
        assert.ok(response && !response.error, JSON.stringify(response?.error));
        const text: string = response.result?.content?.[0]?.text ?? '';
        assert.ok(text.includes('Encrypted Matrix-Vector Products'), text);
        assert.ok(text.includes('Abstract'), text);
        assert.ok(!text.includes('Unsupported content type'), text);
      }, results);
    }
  } else {
    console.log('[SKIP] browser-solver endpoint not set — skipping real protected-PDF test');
  }

  printTestSummary(results, 'E2E: Browser Solver URL Reader');
  return results;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  runTests().then((result) => process.exit(result.failed > 0 ? 1 : 0)).catch(console.error);
}

export { runTests };
