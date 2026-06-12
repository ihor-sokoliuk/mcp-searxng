#!/usr/bin/env tsx

/**
 * Integration Tests: MCP handler dispatch via InMemoryTransport
 *
 * Wires a real SDK Client to createMcpServer() using InMemoryTransport.
 * Every setRequestHandler in src/index.ts is exercised through the protocol.
 * Outbound fetch is intercepted by FetchMocker — no real network needed.
 */

import { strict as assert } from 'node:assert';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../src/index.js';
import { FetchMocker, createMockFetch } from '../helpers/mock-fetch.js';
import { testFunction, createTestResults, printTestSummary } from '../helpers/test-utils.js';

const results = createTestResults();
const fetchMocker = new FetchMocker();

/** Spin up a fresh Client↔Server pair for each test. Call client.close() when done. */
async function connect() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcpServer = createMcpServer();
  const client = new Client(
    { name: 'test-client', version: '1.0.0' },
    { capabilities: {} }
  );
  await mcpServer.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, mcpServer };
}

/** Minimal valid SearXNG JSON response */
const SEARXNG_RESPONSE = JSON.stringify({
  results: [
    {
      title: 'Test Result',
      url: 'https://example.com/result',
      content: 'A test snippet',
      score: 1.0,
    },
  ],
});

const MANY_SEARXNG_RESULTS_RESPONSE = JSON.stringify({
  results: Array.from({ length: 5 }, (_, index) => ({
    title: `Result ${index + 1}`,
    url: `https://example.com/${index + 1}`,
    content: `Snippet ${index + 1}`,
    score: 1 - index * 0.1,
  })),
});

/** Minimal HTML for URL reader */
const HTML_RESPONSE = '<html><body><h1>Hello</h1><p>World</p></body></html>';

async function runTests() {
  console.log('🧪 Integration Testing: MCP handler dispatch (InMemoryTransport)\n');

  // ── tools/list ──────────────────────────────────────────────────────────────

  await testFunction('tools/list returns searxng_web_search and web_url_read', async () => {
    const { client } = await connect();
    const result = await client.listTools();

    assert.equal(result.tools.length, 2);
    assert.ok(result.tools.find((t) => t.name === 'searxng_web_search'), 'missing searxng_web_search');
    assert.ok(result.tools.find((t) => t.name === 'web_url_read'), 'missing web_url_read');

    await client.close();
  }, results);

  // ── tools/call: searxng_web_search ──────────────────────────────────────────

  await testFunction('tools/call searxng_web_search returns text content', async () => {
    process.env.SEARXNG_URL = 'http://localhost:8080';
    fetchMocker.mock(createMockFetch({ body: SEARXNG_RESPONSE }));
    const { client } = await connect();

    const result = await client.callTool({
      name: 'searxng_web_search',
      arguments: { query: 'test query' },
    });

    assert.ok(Array.isArray(result.content), 'content should be an array');
    assert.equal(result.content[0].type, 'text');
    assert.ok(
      (result.content[0] as { type: string; text: string }).text.includes('Test Result'),
      'result text should include the mocked title'
    );

    fetchMocker.restore();
    delete process.env.SEARXNG_URL;
    await client.close();
  }, results);

  await testFunction('tools/call searxng_web_search with all optional params succeeds', async () => {
    process.env.SEARXNG_URL = 'http://localhost:8080';
    fetchMocker.mock(createMockFetch({ body: SEARXNG_RESPONSE }));
    const { client } = await connect();

    const result = await client.callTool({
      name: 'searxng_web_search',
      arguments: {
        query: 'test',
        pageno: 2,
        time_range: 'week',
        language: 'en',
        safesearch: 1,
        min_score: 0.5,
      },
    });

    assert.equal(result.content[0].type, 'text');

    fetchMocker.restore();
    delete process.env.SEARXNG_URL;
    await client.close();
  }, results);

  await testFunction('tools/call searxng_web_search honors num_results', async () => {
    process.env.SEARXNG_URL = 'http://localhost:8080';
    fetchMocker.mock(createMockFetch({ body: MANY_SEARXNG_RESULTS_RESPONSE }));
    const { client } = await connect();

    const result = await client.callTool({
      name: 'searxng_web_search',
      arguments: {
        query: 'test',
        num_results: 2,
      },
    });

    const text = (result.content[0] as { type: string; text: string }).text;
    assert.ok(text.includes('Result 1'));
    assert.ok(text.includes('Result 2'));
    assert.ok(!text.includes('Result 3'));

    fetchMocker.restore();
    delete process.env.SEARXNG_URL;
    await client.close();
  }, results);

  await testFunction('tools/call searxng_web_search with invalid args throws protocol error', async () => {
    const { client } = await connect();

    try {
      await client.callTool({
        name: 'searxng_web_search',
        arguments: { notQuery: 'oops' },
      });
      assert.fail('Expected error was not thrown');
    } catch (error) {
      assert.ok(error instanceof Error, 'should throw an Error');
      assert.ok(
        error.message.toLowerCase().includes('invalid') ||
        error.message.toLowerCase().includes('argument'),
        `unexpected message: ${error.message}`
      );
    }

    await client.close();
  }, results);

  // ── tools/call: web_url_read ─────────────────────────────────────────────────

  await testFunction('tools/call web_url_read returns markdown text', async () => {
    fetchMocker.mock(createMockFetch({ body: HTML_RESPONSE }));
    const { client } = await connect();

    const result = await client.callTool({
      name: 'web_url_read',
      arguments: { url: 'https://example.com' },
    });

    assert.equal(result.content[0].type, 'text');
    assert.ok(
      (result.content[0] as { type: string; text: string }).text.length > 0,
      'result text should be non-empty'
    );

    fetchMocker.restore();
    await client.close();
  }, results);

  await testFunction('tools/call web_url_read with pagination options succeeds', async () => {
    fetchMocker.mock(createMockFetch({ body: HTML_RESPONSE }));
    const { client } = await connect();

    const result = await client.callTool({
      name: 'web_url_read',
      arguments: { url: 'https://example.com', startChar: 0, maxLength: 100 },
    });

    assert.equal(result.content[0].type, 'text');

    fetchMocker.restore();
    await client.close();
  }, results);

  await testFunction('tools/call web_url_read with readHeadings=true succeeds', async () => {
    fetchMocker.mock(createMockFetch({ body: HTML_RESPONSE }));
    const { client } = await connect();

    const result = await client.callTool({
      name: 'web_url_read',
      arguments: { url: 'https://example.com', readHeadings: true },
    });

    assert.equal(result.content[0].type, 'text');

    fetchMocker.restore();
    await client.close();
  }, results);

  await testFunction('tools/call web_url_read with invalid args throws protocol error', async () => {
    const { client } = await connect();

    try {
      await client.callTool({
        name: 'web_url_read',
        arguments: { notUrl: 'oops' },
      });
      assert.fail('Expected error was not thrown');
    } catch (error) {
      assert.ok(error instanceof Error);
      assert.ok(
        error.message.toLowerCase().includes('invalid') ||
        error.message.toLowerCase().includes('argument'),
        `unexpected message: ${error.message}`
      );
    }

    await client.close();
  }, results);

  // ── tools/call: unknown tool ─────────────────────────────────────────────────

  await testFunction('tools/call unknown tool throws protocol error', async () => {
    const { client } = await connect();

    try {
      await client.callTool({ name: 'non_existent_tool', arguments: {} });
      assert.fail('Expected error was not thrown');
    } catch (error) {
      assert.ok(error instanceof Error);
      assert.ok(
        error.message.toLowerCase().includes('unknown') ||
        error.message.toLowerCase().includes('tool'),
        `unexpected message: ${error.message}`
      );
    }

    await client.close();
  }, results);

  // ── logging/setLevel ──────────────────────────────────────────────────────────

  await testFunction('logging/setLevel accepted without error', async () => {
    const { client } = await connect();

    // setLoggingLevel sends a logging/setLevel request; no return value expected
    await client.setLoggingLevel('debug');
    // If it threw, the test fails; reaching here means the handler ran successfully.

    await client.close();
  }, results);

  // ── resources/list ───────────────────────────────────────────────────────────

  await testFunction('resources/list returns config and help resources', async () => {
    const { client } = await connect();

    const result = await client.listResources();

    assert.ok(Array.isArray(result.resources));
    assert.ok(
      result.resources.find((r) => r.uri === 'config://server-config'),
      'missing config resource'
    );
    assert.ok(
      result.resources.find((r) => r.uri === 'help://usage-guide'),
      'missing help resource'
    );

    await client.close();
  }, results);

  // ── resources/templates/list ─────────────────────────────────────────────────

  await testFunction('resources/templates/list returns empty list', async () => {
    const { client } = await connect();

    const result = await client.listResourceTemplates();

    assert.ok(Array.isArray(result.resourceTemplates));
    assert.equal(result.resourceTemplates.length, 0);

    await client.close();
  }, results);

  // ── resources/read ───────────────────────────────────────────────────────────

  await testFunction('resources/read config://server-config returns valid JSON', async () => {
    const { client } = await connect();

    const result = await client.readResource({ uri: 'config://server-config' });

    assert.ok(Array.isArray(result.contents));
    assert.equal(result.contents[0].uri, 'config://server-config');
    assert.equal((result.contents[0] as any).mimeType, 'application/json');

    const text = (result.contents[0] as { text?: string }).text ?? '';
    assert.doesNotThrow(() => JSON.parse(text), 'config resource must be valid JSON');

    await client.close();
  }, results);

  await testFunction('resources/read help://usage-guide returns non-empty markdown', async () => {
    const { client } = await connect();

    const result = await client.readResource({ uri: 'help://usage-guide' });

    assert.ok(Array.isArray(result.contents));
    const text = (result.contents[0] as { text?: string }).text ?? '';
    assert.ok(text.length > 0, 'help resource must be non-empty');

    await client.close();
  }, results);

  await testFunction('resources/read unknown URI throws protocol error', async () => {
    const { client } = await connect();

    try {
      await client.readResource({ uri: 'unknown://does-not-exist' });
      assert.fail('Expected error was not thrown');
    } catch (error) {
      assert.ok(error instanceof Error);
      assert.ok(
        error.message.toLowerCase().includes('unknown') ||
        error.message.toLowerCase().includes('resource'),
        `unexpected message: ${error.message}`
      );
    }

    await client.close();
  }, results);

  printTestSummary(results, 'MCP Handler Dispatch');
  return results;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  runTests().then((r) => process.exit(r.failed > 0 ? 1 : 0)).catch(console.error);
}

export { runTests };
