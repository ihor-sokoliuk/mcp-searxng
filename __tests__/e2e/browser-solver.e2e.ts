#!/usr/bin/env tsx

/**
 * E2E Tests: browser-solver-backed web_url_read through the built MCP STDIO
 * transport. The deterministic local test always runs. The real protected-PDF
 * test runs when FLARESOLVERR_URL points at an available service.
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

    try {
      const responses = await spawnWithMessagesAsync(
        readUrlMessages(target.url),
        'https://test-searx.example.com',
        15_000,
        {
          FLARESOLVERR_URL: solver.url,
          BYPARR_URL: undefined,
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
    } finally {
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

  const matrixRequested = process.env.BROWSER_SOLVER_REAL_MATRIX === 'true';
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

  if (matrixRequested && realProviders.some(({ endpoint }) => !endpoint)) {
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
