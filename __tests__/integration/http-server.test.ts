#!/usr/bin/env tsx

/**
 * Integration Tests: http-server.ts
 *
 * Uses supertest to exercise the full Express request/response cycle.
 */

import { strict as assert } from 'node:assert';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createHttpServer } from '../../src/http-server.js';
import { testFunction, createTestResults, printTestSummary } from '../helpers/test-utils.js';
import { EnvManager } from '../helpers/env-utils.js';

const results = createTestResults();
const envManager = new EnvManager();

function createTestMcpServer(): McpServer {
  return new McpServer(
    { name: 'test-server', version: '1.0.0' },
    { capabilities: { logging: {}, tools: {}, resources: {} } }
  );
}

async function captureConsoleOutput(action: () => Promise<void>): Promise<string[]> {
  const originalError = console.error;
  const originalWarn = console.warn;
  const output: string[] = [];
  const capture = (...args: unknown[]) => {
    output.push(args.map(arg => {
      if (arg instanceof Error) {
        // Include `.code` explicitly: express-rate-limit logs a ValidationError
        // whose code (e.g. ERR_ERL_UNEXPECTED_X_FORWARDED_FOR) lives on `.code`,
        // so the assertion should not rely on it also appearing in `.message`.
        const code = (arg as { code?: unknown }).code;
        return code !== undefined
          ? `${arg.name}[${String(code)}]: ${arg.message}`
          : `${arg.name}: ${arg.message}`;
      }
      return String(arg);
    }).join(' '));
  };

  console.error = capture;
  console.warn = capture;

  try {
    await action();
  } finally {
    console.error = originalError;
    console.warn = originalWarn;
  }

  return output;
}

async function runTests() {
  console.log('🧪 Integration Testing: http-server.ts\n');

  await testFunction('default trust proxy setting remains disabled', async () => {
    envManager.delete('MCP_HTTP_TRUST_PROXY');

    const app = await createHttpServer(() => createTestMcpServer());
    assert.equal(app.get('trust proxy'), false);

    envManager.restore();
  }, results);

  await testFunction('GET /health accepts X-Forwarded-For when trust proxy is unset', async () => {
    envManager.delete('MCP_HTTP_TRUST_PROXY');

    const app = await createHttpServer(() => createTestMcpServer());
    let status: number | undefined;
    await captureConsoleOutput(async () => {
      const res = await request(app)
        .get('/health')
        .set('X-Forwarded-For', '203.0.113.10');
      status = res.status;
    });

    assert.equal(status, 200);

    envManager.restore();
  }, results);

  await testFunction('MCP_HTTP_TRUST_PROXY=true sets Express trust proxy to true', async () => {
    envManager.set('MCP_HTTP_TRUST_PROXY', 'true');

    const app = await createHttpServer(() => createTestMcpServer());
    assert.equal(app.get('trust proxy'), true);

    envManager.restore();
  }, results);

  await testFunction('MCP_HTTP_TRUST_PROXY=1 sets Express trust proxy to one hop', async () => {
    envManager.set('MCP_HTTP_TRUST_PROXY', '1');

    const app = await createHttpServer(() => createTestMcpServer());
    assert.equal(app.get('trust proxy'), 1);

    envManager.restore();
  }, results);

  await testFunction('MCP_HTTP_TRUST_PROXY subnet value passes through to Express', async () => {
    envManager.set('MCP_HTTP_TRUST_PROXY', '10.0.0.0/8');

    const app = await createHttpServer(() => createTestMcpServer());
    assert.equal(app.get('trust proxy'), '10.0.0.0/8');

    envManager.restore();
  }, results);

  await testFunction('GET /health returns healthy status', async () => {
    const app = await createHttpServer(() => createTestMcpServer());
    const res = await request(app).get('/health');

    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'healthy');
    assert.equal(res.body.transport, 'http');
    assert.ok(typeof res.body.version === 'string');
    assert.equal(res.body.server, 'ihor-sokoliuk/mcp-searxng');
  }, results);

  await testFunction('GET /health includes CORS headers', async () => {
    const app = await createHttpServer(() => createTestMcpServer());
    const res = await request(app)
      .get('/health')
      .set('Origin', 'http://example.com');

    assert.equal(res.status, 200);
    assert.ok(res.headers['access-control-allow-origin']);
  }, results);

  await testFunction('CORS allows expected headers', async () => {
    const app = await createHttpServer(() => createTestMcpServer());
    const res = await request(app)
      .options('/mcp')
      .set('Origin', 'http://example.com')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'Content-Type, mcp-session-id, authorization, mcp-protocol-version');

    assert.equal(res.status, 204, 'OPTIONS preflight should succeed');
    const allowHeaders = (res.headers['access-control-allow-headers'] || '').toLowerCase();
    const expected = ['content-type', 'mcp-session-id', 'authorization', 'mcp-protocol-version'];
    for (const header of expected) {
      assert.ok(
        allowHeaders.includes(header),
        `Expected '${header}' in Access-Control-Allow-Headers, got: ${allowHeaders}`
      );
    }
  }, results);

  await testFunction('POST /mcp without sessionId and non-initialize body returns 400', async () => {
    const app = await createHttpServer(() => createTestMcpServer());

    const res = await request(app)
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .send({ jsonrpc: '2.0', method: 'tools/list', id: 1 });

    assert.equal(res.status, 400);
    assert.equal(res.body.jsonrpc, '2.0');
    assert.ok(res.body.error);
    assert.equal(res.body.error.code, -32000);
    assert.equal(res.body.error.message, 'Bad Request: No valid session ID provided');
  }, results);

  await testFunction('POST /mcp with unknown sessionId and non-initialize body returns 404 Session not found', async () => {
    const app = await createHttpServer(() => createTestMcpServer());

    const res = await request(app)
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .set('mcp-session-id', 'unknown-session-abc')
      .send({ jsonrpc: '2.0', method: 'tools/list', id: 1 });

    assert.equal(res.status, 404);
    assert.equal(res.body.jsonrpc, '2.0');
    assert.ok(res.body.error);
    assert.equal(res.body.error.code, -32001);
    assert.equal(res.body.error.message, 'Session not found');
  }, results);

  await testFunction('GET /mcp without sessionId returns 400', async () => {
    const app = await createHttpServer(() => createTestMcpServer());

    const res = await request(app).get('/mcp');

    assert.equal(res.status, 400);
    assert.ok(res.text.includes('Invalid or missing session ID'));
  }, results);

  await testFunction('GET /mcp with unknown sessionId returns 400', async () => {
    const app = await createHttpServer(() => createTestMcpServer());

    const res = await request(app)
      .get('/mcp')
      .set('mcp-session-id', 'nonexistent-session-xyz');

    assert.equal(res.status, 400);
    assert.ok(res.text.includes('Invalid or missing session ID'));
  }, results);

  await testFunction('DELETE /mcp without sessionId returns 400', async () => {
    const app = await createHttpServer(() => createTestMcpServer());

    const res = await request(app).delete('/mcp');

    assert.equal(res.status, 400);
    assert.ok(res.text.includes('Invalid or missing session ID'));
  }, results);

  await testFunction('DELETE /mcp with unknown sessionId returns 400', async () => {
    const app = await createHttpServer(() => createTestMcpServer());

    const res = await request(app)
      .delete('/mcp')
      .set('mcp-session-id', 'nonexistent-session-xyz');

    assert.equal(res.status, 400);
    assert.ok(res.text.includes('Invalid or missing session ID'));
  }, results);

  await testFunction('POST /mcp with initialize request creates session', async () => {
    const app = await createHttpServer(() => createTestMcpServer());

    const res = await request(app)
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' }
        }
      });

    // Should succeed (200) and return a session ID
    assert.equal(res.status, 200);
    assert.ok(res.headers['mcp-session-id'], 'Expected mcp-session-id header in response');
  }, results);

  await testFunction('POST /mcp with stale sessionId and initialize request creates new session', async () => {
    const app = await createHttpServer(() => createTestMcpServer());

    const res = await request(app)
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .set('mcp-session-id', 'stale-session-abc')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' }
        }
      });

    assert.equal(res.status, 200);
    assert.ok(res.headers['mcp-session-id'], 'Expected new mcp-session-id header in response');
    assert.notEqual(
      res.headers['mcp-session-id'],
      'stale-session-abc',
      'Server should mint a fresh session id, not echo the stale client-supplied one'
    );
  }, results);

  await testFunction('compatibility mode still allows health and init flow', async () => {
    envManager.delete('MCP_HTTP_HARDEN');
    envManager.delete('MCP_HTTP_AUTH_TOKEN');
    envManager.delete('MCP_HTTP_ALLOWED_ORIGINS');

    const app = await createHttpServer(() => createTestMcpServer());
    const res = await request(app)
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' }
        }
      });

    assert.equal(res.status, 200);
    envManager.restore();
  }, results);

  await testFunction('hardened mode rejects initialize without auth token', async () => {
    envManager.set('MCP_HTTP_HARDEN', 'true');
    envManager.set('MCP_HTTP_AUTH_TOKEN', 'secret-token');
    envManager.set('MCP_HTTP_ALLOWED_ORIGINS', 'https://app.example.com');

    const app = await createHttpServer(() => createTestMcpServer());
    const res = await request(app)
      .post('/mcp')
      .set('Origin', 'https://app.example.com')
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' }
        }
      });

    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, -32001);
    envManager.restore();
  }, results);

  await testFunction('hardened mode + valid bearer + default hosts + matching Host:port initializes (BUG-012 regression)', async () => {
    envManager.set('MCP_HTTP_HARDEN', 'true');
    envManager.set('MCP_HTTP_AUTH_TOKEN', 'secret-token');
    envManager.set('MCP_HTTP_ALLOWED_ORIGINS', 'https://app.example.com');
    envManager.delete('MCP_HTTP_ALLOWED_HOSTS'); // use the port-aware default

    const app = await createHttpServer(() => createTestMcpServer(), 3000);
    const res = await request(app)
      .post('/mcp')
      .set('Host', '127.0.0.1:3000')
      .set('Origin', 'https://app.example.com')
      .set('Authorization', 'Bearer secret-token')
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' }
        }
      });

    // Restore before asserting so a failure cannot leak MCP_HTTP_* into later tests.
    envManager.restore();
    assert.equal(res.status, 200);
    assert.ok(res.headers['mcp-session-id'], 'Expected mcp-session-id header on a successful hardened init');
  }, results);

  await testFunction('hardened mode rejects a Host not in MCP_HTTP_ALLOWED_HOSTS with 403', async () => {
    envManager.set('MCP_HTTP_HARDEN', 'true');
    envManager.set('MCP_HTTP_AUTH_TOKEN', 'secret-token');
    envManager.set('MCP_HTTP_ALLOWED_ORIGINS', 'https://app.example.com');
    envManager.set('MCP_HTTP_ALLOWED_HOSTS', 'allowed.example.com'); // supertest sends 127.0.0.1:<ephemeral>, which will not match

    const app = await createHttpServer(() => createTestMcpServer(), 3000);
    const res = await request(app)
      .post('/mcp')
      .set('Origin', 'https://app.example.com')
      .set('Authorization', 'Bearer secret-token')
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' }
        }
      });

    envManager.restore();
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, -32000);
  }, results);

  await testFunction('multiple sessions can initialize without "Already connected" error', async () => {
    const app = await createHttpServer(() => createTestMcpServer());
    const initBody = (clientName: string) => ({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {},
        clientInfo: { name: clientName, version: '1.0.0' } }
    });
    const res1 = await request(app).post('/mcp')
      .set('Content-Type', 'application/json').set('Accept', 'application/json, text/event-stream')
      .send(initBody('client-1'));
    assert.equal(res1.status, 200);
    const sessionId1 = res1.headers['mcp-session-id'];
    assert.ok(sessionId1, 'First session should get an ID');
    const res2 = await request(app).post('/mcp')
      .set('Content-Type', 'application/json').set('Accept', 'application/json, text/event-stream')
      .send(initBody('client-2'));
    assert.equal(res2.status, 200);
    const sessionId2 = res2.headers['mcp-session-id'];
    assert.ok(sessionId2, 'Second session should get an ID');
    assert.notEqual(sessionId1, sessionId2, 'Sessions should have distinct IDs');
  }, results);

  await testFunction('session reuse: follow-up request on same session succeeds', async () => {
    const app = await createHttpServer(() => createTestMcpServer());

    const initRes = await request(app)
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .send({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {},
          clientInfo: { name: 'reuse-client', version: '1.0.0' } }
      });
    assert.equal(initRes.status, 200);
    const sessionId = initRes.headers['mcp-session-id'];
    assert.ok(sessionId, 'should receive a session ID');

    const listRes = await request(app)
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .set('mcp-session-id', sessionId)
      .send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    assert.equal(listRes.status, 200, 'follow-up request should succeed on existing session');
  }, results);

  await testFunction('session cleanup: DELETE removes session so subsequent requests fail', async () => {
    const app = await createHttpServer(() => createTestMcpServer());

    const initRes = await request(app)
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .send({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {},
          clientInfo: { name: 'cleanup-client', version: '1.0.0' } }
      });
    assert.equal(initRes.status, 200);
    const sessionId = initRes.headers['mcp-session-id'];
    assert.ok(sessionId, 'should receive a session ID');

    const deleteRes = await request(app)
      .delete('/mcp')
      .set('mcp-session-id', sessionId);
    assert.equal(deleteRes.status, 200, 'DELETE should succeed for existing session');

    const postRes = await request(app)
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .set('mcp-session-id', sessionId)
      .send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    assert.equal(postRes.status, 404, 'request after DELETE should be rejected');
    assert.equal(postRes.body.error.code, -32001);
    assert.equal(postRes.body.error.message, 'Session not found');
  }, results);

  // --- Rate Limiting ---

  await testFunction('Rate limiting: POST /mcp returns 429 after exceeding initLimiter limit', async () => {
    envManager.set('MCP_RATE_INIT_MAX', '3');
    envManager.set('MCP_RATE_WINDOW_MS', '60000');
    const app = await createHttpServer(() => createTestMcpServer());

    for (let i = 0; i < 3; i++) {
      const res = await request(app)
        .post('/mcp')
        .set('Content-Type', 'application/json')
        .send({ jsonrpc: '2.0', method: 'tools/list', id: i });
      assert.notEqual(res.status, 429, `Request ${i + 1} should not be rate limited yet`);
    }

    const res = await request(app)
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .send({ jsonrpc: '2.0', method: 'tools/list', id: 4 });
    assert.equal(res.status, 429, 'Should be rate limited on 4th request');
    assert.equal(res.body.jsonrpc, '2.0');
    assert.equal(res.body.error.code, -32029);

    envManager.restore();
  }, results);

  await testFunction('Rate limiting: invalid MCP_RATE_INIT_MAX falls back to default (does not fail open)', async () => {
    // 'abc' has no leading digit → raw parseInt yields NaN → pre-fix the limiter
    // was disabled (fail-open). With validation it falls back to the default of 20.
    envManager.set('MCP_RATE_INIT_MAX', 'abc');
    envManager.set('MCP_RATE_WINDOW_MS', '60000');
    const app = await createHttpServer(() => createTestMcpServer());

    let lastStatus = 0;
    for (let i = 0; i < 21; i++) {
      const res = await request(app)
        .post('/mcp')
        .set('Content-Type', 'application/json')
        .send({ jsonrpc: '2.0', method: 'tools/list', id: i });
      lastStatus = res.status;
    }
    // Restore env before asserting so a failed assertion can't leak MCP_RATE_* into later tests.
    envManager.restore();
    assert.equal(lastStatus, 429, 'limiter must stay active (default 20) on invalid input, not fail open');
  }, results);

  await testFunction('Rate limiting: GET /mcp returns 429 after exceeding sessionLimiter limit', async () => {
    envManager.set('MCP_RATE_SESSION_MAX', '3');
    envManager.set('MCP_RATE_WINDOW_MS', '60000');
    const app = await createHttpServer(() => createTestMcpServer());

    for (let i = 0; i < 3; i++) {
      const res = await request(app)
        .get('/mcp')
        .set('mcp-session-id', 'nonexistent');
      assert.notEqual(res.status, 429, `GET request ${i + 1} should not be rate limited yet`);
    }

    const res = await request(app)
      .get('/mcp')
      .set('mcp-session-id', 'nonexistent');
    assert.equal(res.status, 429, 'Should be rate limited on 4th GET request');

    envManager.restore();
  }, results);

  await testFunction('Rate limiting: DELETE /mcp returns 429 after exceeding sessionLimiter limit', async () => {
    envManager.set('MCP_RATE_SESSION_MAX', '3');
    envManager.set('MCP_RATE_WINDOW_MS', '60000');
    const app = await createHttpServer(() => createTestMcpServer());

    for (let i = 0; i < 3; i++) {
      const res = await request(app)
        .delete('/mcp')
        .set('mcp-session-id', 'nonexistent');
      assert.notEqual(res.status, 429, `DELETE request ${i + 1} should not be rate limited yet`);
    }

    const res = await request(app)
      .delete('/mcp')
      .set('mcp-session-id', 'nonexistent');
    assert.equal(res.status, 429, 'Should be rate limited on 4th DELETE request');

    envManager.restore();
  }, results);

  await testFunction('Rate limiting: RateLimit-* headers present on /mcp POST response', async () => {
    const app = await createHttpServer(() => createTestMcpServer());

    const res = await request(app)
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .send({ jsonrpc: '2.0', method: 'tools/list', id: 1 });

    assert.ok(
      res.headers['ratelimit-limit'] || res.headers['x-ratelimit-limit'],
      'RateLimit-Limit header should be present'
    );
    assert.ok(
      res.headers['ratelimit-remaining'] || res.headers['x-ratelimit-remaining'],
      'RateLimit-Remaining header should be present'
    );
  }, results);

  await testFunction('Rate limiting: RateLimit-* headers present on /health response', async () => {
    const app = await createHttpServer(() => createTestMcpServer());

    const res = await request(app).get('/health');

    assert.ok(
      res.headers['ratelimit-limit'] || res.headers['x-ratelimit-limit'],
      'RateLimit-Limit header should be present on /health'
    );
    assert.ok(
      res.headers['ratelimit-remaining'] || res.headers['x-ratelimit-remaining'],
      'RateLimit-Remaining header should be present on /health'
    );
  }, results);

  await testFunction('Rate limiting: trust proxy suppresses X-Forwarded-For validation warning', async () => {
    envManager.delete('MCP_HTTP_TRUST_PROXY');

    const defaultApp = await createHttpServer(() => createTestMcpServer());
    const defaultOutput = await captureConsoleOutput(async () => {
      await request(defaultApp)
        .post('/mcp')
        .set('Content-Type', 'application/json')
        .set('X-Forwarded-For', '203.0.113.10')
        .send({ jsonrpc: '2.0', method: 'tools/list', id: 1 });
    });
    assert.ok(
      defaultOutput.some(line => line.includes('ERR_ERL_UNEXPECTED_X_FORWARDED_FOR')),
      'negative control should emit express-rate-limit X-Forwarded-For validation warning'
    );

    envManager.set('MCP_HTTP_TRUST_PROXY', 'true');

    const trustedApp = await createHttpServer(() => createTestMcpServer());
    const trustedOutput = await captureConsoleOutput(async () => {
      await request(trustedApp)
        .post('/mcp')
        .set('Content-Type', 'application/json')
        .set('X-Forwarded-For', '203.0.113.10')
        .send({ jsonrpc: '2.0', method: 'tools/list', id: 1 });
    });
    assert.equal(trustedApp.get('trust proxy'), true);
    assert.ok(
      !trustedOutput.some(line => line.includes('ERR_ERL_UNEXPECTED_X_FORWARDED_FOR')),
      'trusted proxy should suppress express-rate-limit X-Forwarded-For validation warning'
    );

    envManager.restore();
  }, results);

  await testFunction('Rate limiting: POST /mcp limit resets after window expires', async () => {
    envManager.set('MCP_RATE_INIT_MAX', '2');
    envManager.set('MCP_RATE_WINDOW_MS', '200');
    const app = await createHttpServer(() => createTestMcpServer());

    // Exhaust the limit
    for (let i = 0; i < 2; i++) {
      await request(app).post('/mcp').set('Content-Type', 'application/json')
        .send({ jsonrpc: '2.0', method: 'tools/list', id: i });
    }
    const blockedRes = await request(app).post('/mcp').set('Content-Type', 'application/json')
      .send({ jsonrpc: '2.0', method: 'tools/list', id: 3 });
    assert.equal(blockedRes.status, 429, 'Should be rate limited before window resets');

    // Wait for the window to expire
    await new Promise(resolve => setTimeout(resolve, 400));

    const resetRes = await request(app).post('/mcp').set('Content-Type', 'application/json')
      .send({ jsonrpc: '2.0', method: 'tools/list', id: 4 });
    assert.notEqual(resetRes.status, 429, 'Should not be rate limited after window resets');

    envManager.restore();
  }, results);

  printTestSummary(results, 'HTTP Server Integration');
  return results;
}

// Run if executed directly
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  runTests().then(results => {
    process.exit(results.failed > 0 ? 1 : 0);
  }).catch(console.error);
}

export { runTests };
