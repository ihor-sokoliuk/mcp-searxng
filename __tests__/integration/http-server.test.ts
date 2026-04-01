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

const results = createTestResults();

function createTestMcpServer(): McpServer {
  return new McpServer(
    { name: 'test-server', version: '1.0.0' },
    { capabilities: { logging: {}, tools: {}, resources: {} } }
  );
}

async function runTests() {
  console.log('🧪 Integration Testing: http-server.ts\n');

  await testFunction('GET /health returns healthy status', async () => {
    const app = await createHttpServer(createTestMcpServer());
    const res = await request(app).get('/health');

    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'healthy');
    assert.equal(res.body.transport, 'http');
    assert.ok(typeof res.body.version === 'string');
    assert.equal(res.body.server, 'ihor-sokoliuk/mcp-searxng');
  }, results);

  await testFunction('GET /health includes CORS headers', async () => {
    const app = await createHttpServer(createTestMcpServer());
    const res = await request(app)
      .get('/health')
      .set('Origin', 'http://example.com');

    assert.equal(res.status, 200);
    assert.ok(res.headers['access-control-allow-origin']);
  }, results);

  await testFunction('POST /mcp without sessionId and non-initialize body returns 400', async () => {
    const app = await createHttpServer(createTestMcpServer());

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
    const app = await createHttpServer(createTestMcpServer());

    const res = await request(app)
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .set('mcp-session-id', 'unknown-session-abc')
      .send({ jsonrpc: '2.0', method: 'tools/list', id: 1 });

    // mcp-session-id is set but transport not found — falls through to invalid request
    assert.equal(res.status, 400);
  }, results);

  await testFunction('GET /mcp without sessionId returns 400', async () => {
    const app = await createHttpServer(createTestMcpServer());

    const res = await request(app).get('/mcp');

    assert.equal(res.status, 400);
    assert.ok(res.text.includes('Invalid or missing session ID'));
  }, results);

  await testFunction('GET /mcp with unknown sessionId returns 400', async () => {
    const app = await createHttpServer(createTestMcpServer());

    const res = await request(app)
      .get('/mcp')
      .set('mcp-session-id', 'nonexistent-session-xyz');

    assert.equal(res.status, 400);
    assert.ok(res.text.includes('Invalid or missing session ID'));
  }, results);

  await testFunction('DELETE /mcp without sessionId returns 400', async () => {
    const app = await createHttpServer(createTestMcpServer());

    const res = await request(app).delete('/mcp');

    assert.equal(res.status, 400);
    assert.ok(res.text.includes('Invalid or missing session ID'));
  }, results);

  await testFunction('DELETE /mcp with unknown sessionId returns 400', async () => {
    const app = await createHttpServer(createTestMcpServer());

    const res = await request(app)
      .delete('/mcp')
      .set('mcp-session-id', 'nonexistent-session-xyz');

    assert.equal(res.status, 400);
    assert.ok(res.text.includes('Invalid or missing session ID'));
  }, results);

  await testFunction('POST /mcp with initialize request creates session', async () => {
    const app = await createHttpServer(createTestMcpServer());

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
