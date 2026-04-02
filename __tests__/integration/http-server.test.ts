#!/usr/bin/env tsx

/**
 * Integration Tests: http-server.ts
 *
 * Uses supertest to exercise the full Express request/response cycle.
 */

import { strict as assert } from 'node:assert';
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

async function runTests() {
  console.log('🧪 Integration Testing: http-server.ts\n');

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
  }, results);

  await testFunction('POST /mcp with unknown sessionId and non-initialize body returns 400', async () => {
    const app = await createHttpServer(() => createTestMcpServer());

    const res = await request(app)
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .set('mcp-session-id', 'unknown-session-abc')
      .send({ jsonrpc: '2.0', method: 'tools/list', id: 1 });

    // mcp-session-id is set but transport not found — falls through to invalid request
    assert.equal(res.status, 400);
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
    envManager.restore();
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

  printTestSummary(results, 'HTTP Server Integration');
  return results;
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runTests().then(results => {
    process.exit(results.failed > 0 ? 1 : 0);
  }).catch(console.error);
}

export { runTests };
