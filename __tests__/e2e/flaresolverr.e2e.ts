#!/usr/bin/env tsx

/**
 * E2E Tests: FlareSolverr-backed web_url_read through the built MCP STDIO
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
        'content-type': 'text/html; charset=utf-8',
      });
      res.end(req.method === 'HEAD' ? '' : '<html><body><h1>Solver E2E</h1></body></html>');
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
          MCP_HTTP_ALLOW_PRIVATE_URLS: 'true',
          NO_PROXY: '127.0.0.1',
        },
      );
      const response = responses[2];
      assert.ok(response && !response.error, JSON.stringify(response?.error));
      const text: string = response.result?.content?.[0]?.text ?? '';
      assert.ok(text.includes('# Solver E2E'), text);
      assert.equal(replayUserAgent, 'flaresolverr-e2e-agent');
      assert.equal(replayCookie, 'cf_clearance=e2e-token');
    } finally {
      await solver.close();
      await target.close();
    }
  }, results);

  if (process.env.FLARESOLVERR_URL) {
    await testFunction('real Cloudflare-protected IACR PDF text is extracted through FlareSolverr', async () => {
      const responses = await spawnWithMessagesAsync(
        readUrlMessages(PROTECTED_PDF_URL),
        'https://test-searx.example.com',
        90_000,
      );
      const response = responses[2];
      assert.ok(response && !response.error, JSON.stringify(response?.error));
      const text: string = response.result?.content?.[0]?.text ?? '';
      assert.ok(text.includes('Encrypted Matrix-Vector Products'), text);
      assert.ok(text.includes('Abstract'), text);
      assert.ok(!text.includes('Unsupported content type'), text);
    }, results);
  } else {
    console.log('[SKIP] FLARESOLVERR_URL not set — skipping real protected-PDF test');
  }

  printTestSummary(results, 'E2E: FlareSolverr URL Reader');
  return results;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  runTests().then((result) => process.exit(result.failed > 0 ? 1 : 0)).catch(console.error);
}

export { runTests };
