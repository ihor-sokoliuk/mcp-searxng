#!/usr/bin/env tsx

/**
 * E2E Tests: AbortController timeout fires against a hanging local server.
 *
 * Requires: built dist/cli.js only (no live SearXNG needed).
 * Run: npm run test:e2e
 *
 * What mocks can't prove: that the AbortController timeout in performWebSearch
 * and fetchAndConvertToMarkdown actually fires against a real hanging connection,
 * not just a mock abort signal.
 */

import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import http from 'node:http';
import type { Socket } from 'node:net';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  checkSkipConditions,
  INIT_PARAMS,
  spawnWithMessagesAsync,
  spawnWithMessages,
} from './helpers/spawn-server.js';
import { testFunction, createTestResults, printTestSummary } from '../helpers/test-utils.js';

const results = createTestResults();

/** Starts an HTTP server that accepts connections but never responds. */
async function startHangingServer(): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((_req, _res) => {
      // Intentionally never call res.end() — connection hangs
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}

/**
 * Serves response headers without completing the body. The socket tracking is
 * deliberate: a failing RED test must still leave no listener or connection.
 */
async function startHeadersThenStallServer(
  handleRequest: (request: http.IncomingMessage, response: http.ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const sockets = new Set<Socket>();
    const server = http.createServer(handleRequest);
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done) => {
          for (const socket of sockets) socket.destroy();
          server.close(() => done());
        }),
      });
    });
  });
}

async function startAdmissionHttpCli(stateless = false): Promise<{ url: URL; close: () => Promise<void> }> {
  const port = await new Promise<number>((resolve, reject) => {
    const reservation = http.createServer();
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', () => {
      const address = reservation.address();
      if (!address || typeof address === 'string') {
        reservation.close(() => reject(new Error('Could not reserve a loopback port')));
        return;
      }
      reservation.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
  const child = spawn(process.execPath, ['dist/cli.js'], {
    env: {
      ...process.env,
      MCP_HTTP_HOST: '127.0.0.1',
      MCP_HTTP_PORT: String(port),
      MCP_TOOL_RATE_WINDOW_MS: '60000',
      MCP_TOOL_RATE_MAX: '1',
      MCP_TOOL_MAX_IN_FLIGHT: '1',
      MCP_HTTP_STATELESS: stateless ? 'true' : 'false',
      SEARXNG_URL: 'https://test-searx.example.com',
    },
    stdio: 'ignore',
    windowsHide: true,
  });
  const url = new URL(`http://127.0.0.1:${port}/mcp`);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Admission HTTP CLI exited early with ${child.exitCode}`);
    try {
      const response = await fetch(new URL('/health', url));
      if (response.ok) break;
    } catch { /* server is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (Date.now() >= deadline) throw new Error('Admission HTTP CLI did not become healthy');
  return {
    url,
    close: async () => {
      if (child.exitCode !== null) return;
      const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
      child.kill('SIGTERM');
      await Promise.race([closed, new Promise<void>((resolve) => setTimeout(resolve, 5000))]);
      if (child.exitCode === null) child.kill('SIGKILL');
    },
  };
}

// Default fetch timeout in src/search.ts and src/url-reader.ts
const FETCH_TIMEOUT_MS = 10000;
// Allow 3s extra for process startup, JSON parsing, etc.
const TEST_TIMEOUT_MS = FETCH_TIMEOUT_MS + 3000;
const BODY_TIMEOUT_MS = 150;
const BODY_TEST_TIMEOUT_MS = 1500;

function hasToolError(response: any): boolean {
  return Boolean(
    response?.error
    || response?.result?.isError
    || (response?.result?.content?.[0]?.text ?? '').toLowerCase().includes('error'),
  );
}

async function expectBodyDeadline(
  start: number,
  run: () => Promise<Record<number, any>>,
  description: string,
): Promise<void> {
  let responses: Record<number, any>;
  try {
    responses = await run();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${description}: response headers arrived, but the built client did not apply `
      + `SEARXNG_TIMEOUT_MS=${BODY_TIMEOUT_MS} while consuming the body (${detail})`,
    );
  }

  assert.ok(responses[2], `${description}: expected the tool to return a timeout error response`);
  assert.ok(hasToolError(responses[2]), `${description}: expected a timeout error response`);
  assert.ok(
    Date.now() - start < BODY_TEST_TIMEOUT_MS,
    `${description}: expected completion before the outer test deadline`,
  );
}

async function runTests() {
  console.log('⏱  E2E Testing: AbortController timeout (local hanging server)\n');

  // Only check dist exists; no live URL needed for these tests
  const skip = checkSkipConditions(false);
  if (skip) {
    console.log(skip);
    return { passed: 0, failed: 0, errors: [] };
  }

  await testFunction('STDIO applies the configured tool admission budget without corrupting JSON-RPC output', async () => {
    const responses = await spawnWithMessagesAsync(
      [
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: INIT_PARAMS },
        { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'not_a_tool', arguments: {} } },
        { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'searxng_web_search', arguments: { query: 'must-not-run' } } },
      ],
      'https://test-searx.example.com',
      10_000,
      { MCP_TOOL_RATE_WINDOW_MS: '60000', MCP_TOOL_RATE_MAX: '1', MCP_TOOL_MAX_IN_FLIGHT: '1' },
    );

    assert.ok(responses[1]?.result?.serverInfo, JSON.stringify(responses));
    assert.ok(responses[2]?.error, JSON.stringify(responses));
    assert.equal(responses[3]?.result?.isError, true, JSON.stringify(responses));
    assert.equal(responses[3]?.result?.content?.[0]?.text, 'Server busy. Retry later with backoff.');
  }, results);

  await testFunction('built STDIO recovers its tool rate budget after a fixed-window rollover', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['dist/cli.js'],
      cwd: process.cwd(),
      env: {
        ...getDefaultEnvironment(),
        MCP_TOOL_RATE_WINDOW_MS: '5000',
        MCP_TOOL_RATE_MAX: '1',
        MCP_TOOL_MAX_IN_FLIGHT: '1',
        SEARXNG_URL: 'https://test-searx.example.com',
      },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'tool-admission-stdio-recovery', version: '1.0.0' });
    try {
      await client.connect(transport);
      await assert.rejects(() => client.callTool({ name: 'not_a_tool', arguments: {} }), /Unknown tool/);
      const rejection = await client.callTool({ name: 'not_a_tool', arguments: {} });
      assert.equal(rejection.isError, true);
      assert.equal((rejection.content[0] as { text: string }).text, 'Server busy. Retry later with backoff.');
      await new Promise((resolve) => setTimeout(resolve, 5100));
      await assert.rejects(() => client.callTool({ name: 'not_a_tool', arguments: {} }), /Unknown tool/);
    } finally {
      await client.close();
    }
  }, results);

  await testFunction('HTTP applies the same stable tool admission rejection', async () => {
    const server = await startAdmissionHttpCli();
    const client = new Client({ name: 'tool-admission-e2e', version: '1.0.0' });
    try {
      await client.connect(new StreamableHTTPClientTransport(server.url));
      await assert.rejects(() => client.callTool({ name: 'not_a_tool', arguments: {} }));
      const rejection = await client.callTool({ name: 'searxng_web_search', arguments: { query: 'must-not-run' } });
      assert.equal(rejection.isError, true);
      assert.equal((rejection.content[0] as { text: string }).text, 'Server busy. Retry later with backoff.');
      assert.equal((await client.listTools()).tools.length, 4);
      assert.equal((await client.listResources()).resources.length, 2);
      assert.equal((await client.readResource({ uri: 'help://usage-guide' })).contents.length, 1);
      await client.setLoggingLevel('debug');
      assert.equal((await fetch(new URL('/health', server.url))).ok, true);
      const stillExhausted = await client.callTool({ name: 'searxng_web_search', arguments: { query: 'still-must-not-run' } });
      assert.equal(stillExhausted.isError, true);
    } finally {
      await client.close();
      await server.close();
    }
  }, results);

  await testFunction('stateless HTTP requests share the same process tool budget', async () => {
    const server = await startAdmissionHttpCli(true);
    const client = new Client({ name: 'tool-admission-stateless-e2e', version: '1.0.0' });
    try {
      await client.connect(new StreamableHTTPClientTransport(server.url));
      await assert.rejects(() => client.callTool({ name: 'not_a_tool', arguments: {} }), /Unknown tool/);
      const rejection = await client.callTool({ name: 'not_a_tool', arguments: {} });
      assert.equal(rejection.isError, true);
      assert.equal((rejection.content[0] as { text: string }).text, 'Server busy. Retry later with backoff.');
    } finally {
      await client.close();
      await server.close();
    }
  }, results);

  await testFunction('web_url_read times out against a hanging server', async () => {
    const { url, close } = await startHangingServer();

    try {
      const start = Date.now();
      const responses = spawnWithMessages(
        [
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
        ],
        'https://test-searx.example.com',  // SEARXNG_URL is not used by url_read
        TEST_TIMEOUT_MS
      );
      const elapsed = Date.now() - start;

      // The server must have returned an error (timeout/abort), not hung forever
      const r = responses[2];
      assert.ok(r, 'expected a response — server should have timed out, not hung');

      // Either an error field at the protocol level, or isError content
      const hasError = r.error ||
        r.result?.isError ||
        (r.result?.content?.[0]?.text ?? '').toLowerCase().includes('error');
      assert.ok(hasError, `expected error response, got: ${JSON.stringify(r)}`);

      // The whole interaction completed well within TEST_TIMEOUT_MS
      assert.ok(
        elapsed < TEST_TIMEOUT_MS,
        `took ${elapsed}ms — should be under ${TEST_TIMEOUT_MS}ms`
      );
    } finally {
      await close();
    }
  }, results);

  await testFunction('searxng_web_search times out when SEARXNG_URL hangs', async () => {
    const { url, close } = await startHangingServer();

    try {
      const start = Date.now();
      const responses = spawnWithMessages(
        [
          { jsonrpc: '2.0', id: 1, method: 'initialize', params: INIT_PARAMS },
          {
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: {
              name: 'searxng_web_search',
              arguments: { query: 'test' },
            },
          },
        ],
        url,  // point SEARXNG_URL at the hanging server
        TEST_TIMEOUT_MS
      );
      const elapsed = Date.now() - start;

      const r = responses[2];
      assert.ok(r, 'expected a response — server should have timed out, not hung');

      const hasError = r.error ||
        r.result?.isError ||
        (r.result?.content?.[0]?.text ?? '').toLowerCase().includes('error');
      assert.ok(hasError, `expected error response, got: ${JSON.stringify(r)}`);

      assert.ok(elapsed < TEST_TIMEOUT_MS, `took ${elapsed}ms — should be under ${TEST_TIMEOUT_MS}ms`);
    } finally {
      await close();
    }
  }, results);

  await testFunction('searxng_web_search keeps its timeout while a JSON body stalls after headers', async () => {
    const { url, close } = await startHeadersThenStallServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.flushHeaders();
    });

    try {
      const start = Date.now();
      await expectBodyDeadline(
        start,
        () => spawnWithMessagesAsync(
          [
            { jsonrpc: '2.0', id: 1, method: 'initialize', params: INIT_PARAMS },
            {
              jsonrpc: '2.0',
              id: 2,
              method: 'tools/call',
              params: { name: 'searxng_web_search', arguments: { query: 'headers-first-json' } },
            },
          ],
          url,
          BODY_TEST_TIMEOUT_MS,
          { SEARXNG_TIMEOUT_MS: String(BODY_TIMEOUT_MS) },
        ),
        'JSON response body deadline',
      );
    } finally {
      await close();
    }
  }, results);

  await testFunction('searxng_web_search gives its HTML fallback a fresh body deadline', async () => {
    const { url, close } = await startHeadersThenStallServer((request, response) => {
      const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (requestUrl.searchParams.get('format') === 'json') {
        response.writeHead(403, { 'content-type': 'text/plain' });
        response.end('fallback');
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html' });
      response.flushHeaders();
    });

    try {
      const start = Date.now();
      await expectBodyDeadline(
        start,
        () => spawnWithMessagesAsync(
          [
            { jsonrpc: '2.0', id: 1, method: 'initialize', params: INIT_PARAMS },
            {
              jsonrpc: '2.0',
              id: 2,
              method: 'tools/call',
              params: { name: 'searxng_web_search', arguments: { query: 'headers-first-html' } },
            },
          ],
          url,
          BODY_TEST_TIMEOUT_MS,
          {
            SEARXNG_TIMEOUT_MS: String(BODY_TIMEOUT_MS),
            SEARXNG_HTML_FALLBACK: 'true',
          },
        ),
        'HTML fallback response body deadline',
      );
    } finally {
      await close();
    }
  }, results);

  printTestSummary(results, 'E2E: Timeout');
  return results;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  runTests().then((r) => process.exit(r.failed > 0 ? 1 : 0)).catch(console.error);
}

export { runTests };
