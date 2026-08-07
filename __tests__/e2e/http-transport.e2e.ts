#!/usr/bin/env tsx

import { strict as assert } from 'node:assert';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { checkSkipConditions, spawnHttpCli, type SpawnedHttpCli } from './helpers/spawn-server.js';
import { createTestResults, printTestSummary, testFunction } from '../helpers/test-utils.js';
import { packageVersion } from '../../src/version.js';

const results = createTestResults();
const CORE_TOOL_NAMES = [
  'searxng_web_search',
  'searxng_search_suggestions',
  'searxng_instance_info',
  'web_url_read',
];

async function reserveTestPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const reservation = createServer();
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', () => {
      const address = reservation.address();
      if (!address || typeof address === 'string') {
        reservation.close(() => reject(new Error('Failed to reserve test port')));
        return;
      }
      reservation.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function runTests() {
  const skip = checkSkipConditions(false);
  if (skip) {
    console.log(skip);
    return { passed: 0, failed: 0, errors: [] };
  }

  await testFunction('stateful HTTP CLI supports a negotiated MCP session', async () => {
    let server: SpawnedHttpCli | undefined;
    let client: Client | undefined;
    try {
      server = await spawnHttpCli();
      assert.deepEqual(server.health, {
        status: 'healthy',
        server: 'ihor-sokoliuk/mcp-searxng',
        version: packageVersion,
        transport: 'http',
      });
      const transport = new StreamableHTTPClientTransport(server.url);
      client = new Client({ name: 'http-transport-e2e', version: '1.0.0' });
      await client.connect(transport);
      assert.ok(transport.sessionId, 'stateful HTTP transport must negotiate a session ID');
      const tools = await client.listTools();
      assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [...CORE_TOOL_NAMES].sort());
    } finally {
      await client?.close();
      await server?.close();
    }
  }, results);

  await testFunction('stateless HTTP CLI lists tools without a session ID', async () => {
    let server: SpawnedHttpCli | undefined;
    let client: Client | undefined;
    try {
      server = await spawnHttpCli({ stateless: true });
      const transport = new StreamableHTTPClientTransport(server.url);
      client = new Client({ name: 'http-transport-e2e', version: '1.0.0' });
      await client.connect(transport);
      assert.equal(transport.sessionId, undefined);
      const tools = await client.listTools();
      assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [...CORE_TOOL_NAMES].sort());
    } finally {
      await client?.close();
      await server?.close();
    }
  }, results);

  await testFunction('HTTP CLI retries a confirmed EADDRINUSE startup once', async () => {
    let reserveCalls = 0;
    let server: SpawnedHttpCli | undefined;
    try {
      server = await spawnHttpCli({
        reservePort: async () => {
          reserveCalls++;
          if (reserveCalls === 1) throw Object.assign(new Error('deterministic test collision'), { code: 'EADDRINUSE' });
          return await reserveTestPort();
        },
      });
      assert.equal(reserveCalls, 2);
    } finally {
      await server?.close();
    }
  }, results);

  await testFunction('HTTP CLI does not retry when only stdout mentions EADDRINUSE', async () => {
    let reserveCalls = 0;
    await assert.rejects(
      () => spawnHttpCli({
        args: ['-e', "process.stdout.write('EADDRINUSE in child stdout only'); process.exit(7);"],
        reservePort: async () => {
          reserveCalls++;
          return await reserveTestPort();
        },
      }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /HTTP CLI exited before health became ready/);
        assert.match(message, /EADDRINUSE in child stdout only/);
        return true;
      },
    );
    assert.equal(reserveCalls, 1);
  }, results);

  await testFunction('HTTP CLI readiness timeout includes diagnostics and reaps the child', async () => {
    await assert.rejects(
      () => spawnHttpCli({
        readyTimeoutMs: 250,
        args: ['-e', "process.stdout.write('timeout stdout'); process.stderr.write('timeout stderr'); process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000);"],
      }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /Timed out waiting for HTTP CLI health after 250ms/);
        assert.match(message, /timeout stdout/);
        assert.match(message, /timeout stderr/);
        assert.match(message, /cleanup=(?:exitCode=0; signalCode=null|exitCode=null; signalCode=SIGTERM)/);
        return true;
      },
    );
  }, results);

  await testFunction('HTTP CLI diagnostics retain bounded stdout and stderr tails', async () => {
    await assert.rejects(
      () => spawnHttpCli({
        args: ['-e', "process.stdout.write('stdout-head' + 'A'.repeat(70000) + 'stdout-tail'); process.stderr.write('stderr-head' + 'B'.repeat(70000) + 'stderr-tail'); process.exit(7);"],
      }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.doesNotMatch(message, /stdout-head|stderr-head/);
        assert.match(message, /stdout-tail/);
        assert.match(message, /stderr-tail/);
        return true;
      },
    );
  }, results);

  await testFunction('HTTP CLI early exit includes diagnostics and reaps the child', async () => {
    await assert.rejects(
      () => spawnHttpCli({
        args: ['-e', "process.stdout.write('early stdout'); process.stderr.write('early stderr'); process.exit(7);"],
      }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /HTTP CLI exited before health became ready/);
        assert.match(message, /exitCode=7/);
        assert.match(message, /early stdout/);
        assert.match(message, /early stderr/);
        assert.match(message, /cleanup=exitCode=7; signalCode=null/);
        return true;
      },
    );
  }, results);

  printTestSummary(results, 'E2E: HTTP Transport');
  return results;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  runTests().then((r) => process.exit(r.failed > 0 ? 1 : 0)).catch(console.error);
}

export { runTests };
