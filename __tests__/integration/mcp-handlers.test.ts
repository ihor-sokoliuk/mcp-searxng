#!/usr/bin/env tsx

/**
 * Integration Tests: MCP handler dispatch via InMemoryTransport
 *
 * Wires a real SDK Client to createMcpServer() using InMemoryTransport.
 * Every setRequestHandler in src/index.ts is exercised through the protocol.
 * Outbound fetch is intercepted by FetchMocker — no real network needed.
 */

import { strict as assert } from 'node:assert';
import http from 'node:http';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { LoggingMessageNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  createMcpServer,
  createToolAdmissionController,
  TOOL_ADMISSION_REJECTION_MESSAGE,
  ToolAdmissionController,
} from '../../src/index.js';
import {
  normalizePositiveInteger,
  parseBoundedInteger,
  parsePositiveInteger,
  parseStrictInteger,
} from '../../src/env-int.js';
import {
  initializeDiagnosticSanitizer,
  resetDiagnosticSanitizerForTests,
} from '../../src/diagnostic-sanitizer.js';
import { FetchMocker, createCapturingMockFetch, createMockFetch } from '../helpers/mock-fetch.js';
import { testFunction, createTestResults, printTestSummary } from '../helpers/test-utils.js';

const results = createTestResults();
const fetchMocker = new FetchMocker();
const EXPECTED_PROTOCOL_ERROR_MESSAGE =
  'MCP error -32603: ⚠️ Configuration Issues: '
  + 'SEARXNG_URL entry 1 uses unsupported protocol ftp: for search.example.com. '
  + 'Set SEARXNG_URL (e.g., http://localhost:8080 or https://search.example.com)';

/** Spin up a fresh Client↔Server pair for each test. Call client.close() when done. */
function createTestAdmissionController() {
  return new ToolAdmissionController({
    rateWindowMs: 60_000,
    rateMax: 10_000,
    maxInFlight: 256,
  });
}

async function connect(controller = createTestAdmissionController()) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcpServer = createMcpServer(controller);
  const client = new Client(
    { name: 'test-client', version: '1.0.0' },
    { capabilities: {} }
  );
  await mcpServer.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, mcpServer };
}

async function connectWithLogs(controller = createTestAdmissionController()) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcpServer = createMcpServer(controller);
  const client = new Client(
    { name: 'test-client', version: '1.0.0' },
    { capabilities: {} },
  );
  const logs: unknown[] = [];
  client.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => {
    logs.push(notification);
  });
  await mcpServer.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, logs };
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
const LONG_HTML_RESPONSE = '<html><body><p>abcdefghijklmnopqrstuvwxyz</p></body></html>';

async function withLocalHtmlServer(body: string, test: (url: string) => Promise<void>) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(body);
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', resolve);
    server.once('error', reject);
  });

  const address = server.address() as net.AddressInfo;
  try {
    await test(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  }
}

async function withPrivateUrlReadsAllowed(test: () => Promise<void>) {
  const originalValue = process.env.MCP_HTTP_ALLOW_PRIVATE_URLS;
  process.env.MCP_HTTP_ALLOW_PRIVATE_URLS = 'true';
  try {
    await test();
  } finally {
    if (originalValue === undefined) {
      delete process.env.MCP_HTTP_ALLOW_PRIVATE_URLS;
    } else {
      process.env.MCP_HTTP_ALLOW_PRIVATE_URLS = originalValue;
    }
  }
}

async function runTests() {
  console.log('🧪 Integration Testing: MCP handler dispatch (InMemoryTransport)\n');

  await testFunction('bounded tool admission configuration uses strict safe defaults', () => {
    assert.equal(parseStrictInteger(' +001 '), 1);
    assert.equal(parseStrictInteger('1e3'), undefined);
    assert.equal(parsePositiveInteger(undefined, 7), 7);
    assert.equal(parsePositiveInteger('  ', 7), 7);
    assert.equal(parsePositiveInteger('-1', 7), 7);
    assert.equal(normalizePositiveInteger(3, 7), 3);
    assert.equal(normalizePositiveInteger(0, 7), 7);
    assert.deepEqual(parseBoundedInteger(undefined, 300, 1, 10_000), { value: 300, invalid: false });
    assert.deepEqual(parseBoundedInteger('  ', 300, 1, 10_000), { value: 300, invalid: false });
    assert.deepEqual(parseBoundedInteger('  +001  ', 300, 1, 10_000), { value: 1, invalid: false });
    assert.deepEqual(parseBoundedInteger('10000', 300, 1, 10_000), { value: 10_000, invalid: false });
    assert.deepEqual(parseBoundedInteger('0', 300, 1, 10_000), { value: 300, invalid: true });
    assert.deepEqual(parseBoundedInteger('10ms', 300, 1, 10_000), { value: 300, invalid: true });
    assert.deepEqual(parseBoundedInteger('9007199254740992', 300, 1, 10_000), { value: 300, invalid: true });
  }, results);

  await testFunction('tool admission is rate-first, shared, and releases capacity exactly once', () => {
    let now = 0;
    const controller = new ToolAdmissionController(
      { rateWindowMs: 1_000, rateMax: 2, maxInFlight: 1 },
      () => now,
    );
    const first = controller.admit();
    assert.ok(first.release, 'first call should reserve a slot');
    assert.equal(controller.admit().reason, 'concurrency', 'rate admission must precede concurrency');
    first.release!();
    const exhausted = controller.admit();
    assert.equal(exhausted.reason, 'rate');
    now = 1_000;
    const recovered = controller.admit();
    assert.ok(recovered.release, 'the next fixed window should recover the rate budget');
    recovered.release!();
    recovered.release!();
  }, results);

  await testFunction('tool admission warnings are value-free and configuration is read once', () => {
    const originalWindow = process.env.MCP_TOOL_RATE_WINDOW_MS;
    const originalRate = process.env.MCP_TOOL_RATE_MAX;
    const originalInFlight = process.env.MCP_TOOL_MAX_IN_FLIGHT;
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    process.env.MCP_TOOL_RATE_WINDOW_MS = 'window-invalid';
    process.env.MCP_TOOL_RATE_MAX = 'rate-invalid';
    process.env.MCP_TOOL_MAX_IN_FLIGHT = 'in-flight-invalid';
    console.warn = (...values: unknown[]) => { warnings.push(values); };
    try {
      const controller = createToolAdmissionController();
      assert.equal(controller.admit().release !== undefined, true);
      assert.equal(warnings.length, 3);
      const output = warnings.map((warning) => String(warning[0])).join('\n');
      assert.ok(output.includes('MCP_TOOL_RATE_WINDOW_MS'), output);
      assert.ok(output.includes('MCP_TOOL_RATE_MAX'), output);
      assert.ok(output.includes('MCP_TOOL_MAX_IN_FLIGHT'), output);
      assert.ok(output.includes('60000'), output);
      assert.ok(output.includes('300'), output);
      assert.ok(output.includes('16'), output);
      assert.ok(!output.includes('window-invalid'), output);
      assert.ok(!output.includes('rate-invalid'), output);
      assert.ok(!output.includes('in-flight-invalid'), output);
    } finally {
      console.warn = originalWarn;
      if (originalWindow === undefined) delete process.env.MCP_TOOL_RATE_WINDOW_MS;
      else process.env.MCP_TOOL_RATE_WINDOW_MS = originalWindow;
      if (originalRate === undefined) delete process.env.MCP_TOOL_RATE_MAX;
      else process.env.MCP_TOOL_RATE_MAX = originalRate;
      if (originalInFlight === undefined) delete process.env.MCP_TOOL_MAX_IN_FLIGHT;
      else process.env.MCP_TOOL_MAX_IN_FLIGHT = originalInFlight;
    }
  }, results);

  await testFunction('rate-window rollover leaves an outstanding in-flight reservation held', () => {
    let monotonicNow = 10;
    const controller = new ToolAdmissionController(
      { rateWindowMs: 1_000, rateMax: 1, maxInFlight: 1 },
      () => monotonicNow,
    );
    const held = controller.admit();
    assert.ok(held.release);
    const originalDateNow = Date.now;
    try {
      Date.now = () => Number.MAX_SAFE_INTEGER;
      assert.equal(controller.admit().reason, 'rate', 'wall-clock jumps must not reset the rate window');
      Date.now = () => -1_000_000;
      assert.equal(controller.admit().reason, 'rate', 'backward wall-clock jumps must not reset the rate window');
      monotonicNow = 1_010;
      assert.equal(controller.admit().reason, 'concurrency');
    } finally {
      Date.now = originalDateNow;
    }
    held.release!();
    monotonicNow = 2_010;
    assert.ok(controller.admit().release, 'only the rate counter resets at monotonic rollover');
  }, results);

  await testFunction('the in-flight ceiling is exact and racing terminal releases are idempotent', async () => {
    const controller = new ToolAdmissionController({ rateWindowMs: 60_000, rateMax: 10, maxInFlight: 2 });
    let active = 0;
    let peak = 0;
    const reserve = () => {
      const admission = controller.admit();
      assert.ok(admission.release);
      active += 1;
      peak = Math.max(peak, active);
      let terminal = false;
      return () => {
        admission.release!();
        if (terminal) return;
        terminal = true;
        active -= 1;
      };
    };
    const first = reserve();
    const second = reserve();
    assert.equal(controller.admit().reason, 'concurrency');
    assert.equal(peak, 2);
    await Promise.all([Promise.resolve().then(first), Promise.resolve().then(first)]);
    assert.equal(active, 1);
    const third = reserve();
    assert.equal(peak, 2, 'the observed peak must equal, never exceed, the configured ceiling');
    second();
    third();
    assert.equal(active, 0);
  }, results);

  await testFunction('shared servers reject exhausted tool calls while control traffic remains available', async () => {
    const controller = new ToolAdmissionController({ rateWindowMs: 60_000, rateMax: 1, maxInFlight: 1 });
    const first = await connect(controller);
    const second = await connect(controller);
    try {
      await assert.rejects(() => first.client.callTool({ name: 'not_a_tool', arguments: {} }));
      const listed = await second.client.listTools();
      assert.equal(listed.tools.length, 4);
      const rejection = await second.client.callTool({ name: 'not_a_tool', arguments: {} });
      assert.equal(rejection.isError, true);
      assert.equal((rejection.content[0] as { text: string }).text, TOOL_ADMISSION_REJECTION_MESSAGE);
    } finally {
      await first.client.close();
      await second.client.close();
    }
  }, results);

  await testFunction('concurrency rejection starts no extra upstream work and releases after completion', async () => {
    const controller = new ToolAdmissionController({ rateWindowMs: 60_000, rateMax: 3, maxInFlight: 1 });
    const first = await connect(controller);
    const second = await connect(controller);
    const originalUrl = process.env.SEARXNG_URL;
    process.env.SEARXNG_URL = 'http://localhost:8080';
    let fetches = 0;
    let resolveFetch: ((response: Response) => void) | undefined;
    fetchMocker.mock(() => {
      fetches += 1;
      return new Promise<Response>((resolve) => { resolveFetch = resolve; });
    });
    try {
      const pending = first.client.callTool({ name: 'searxng_web_search', arguments: { query: 'first' } });
      while (fetches === 0) await new Promise((resolve) => setTimeout(resolve, 1));
      const rejected = await second.client.callTool({ name: 'searxng_web_search', arguments: { query: 'second' } });
      assert.equal(rejected.isError, true);
      assert.equal(fetches, 1, 'the rejected call must not reach the upstream fetch');
      resolveFetch!(new Response(SEARXNG_RESPONSE, { status: 200, headers: { 'content-type': 'application/json' } }));
      await pending;
      fetchMocker.mock(createMockFetch({ body: SEARXNG_RESPONSE }));
      const afterRelease = await second.client.callTool({ name: 'searxng_web_search', arguments: { query: 'third' } });
      assert.equal(afterRelease.isError, undefined);
    } finally {
      fetchMocker.restore();
      if (originalUrl === undefined) delete process.env.SEARXNG_URL;
      else process.env.SEARXNG_URL = originalUrl;
      await first.client.close();
      await second.client.close();
    }
  }, results);

  await testFunction('a handler failure releases its admission slot for a later accepted call', async () => {
    const controller = new ToolAdmissionController({ rateWindowMs: 60_000, rateMax: 3, maxInFlight: 1 });
    const { client } = await connect(controller);
    const originalUrl = process.env.SEARXNG_URL;
    process.env.SEARXNG_URL = 'http://localhost:8080';
    fetchMocker.mock(createMockFetch({ body: SEARXNG_RESPONSE }));
    try {
      await assert.rejects(() => client.callTool({ name: 'not_a_tool', arguments: {} }));
      const accepted = await client.callTool({ name: 'searxng_web_search', arguments: { query: 'after-failure' } });
      assert.equal(accepted.isError, undefined);
    } finally {
      fetchMocker.restore();
      if (originalUrl === undefined) delete process.env.SEARXNG_URL;
      else process.env.SEARXNG_URL = originalUrl;
      await client.close();
    }
  }, results);

  await testFunction('client cancellation releases an admitted URL-read slot exactly once', async () => {
    const controller = new ToolAdmissionController({ rateWindowMs: 60_000, rateMax: 4, maxInFlight: 1 });
    const { client } = await connect(controller);
    const originalPrivateUrls = process.env.MCP_HTTP_ALLOW_PRIVATE_URLS;
    const originalUrl = process.env.SEARXNG_URL;
    process.env.MCP_HTTP_ALLOW_PRIVATE_URLS = 'true';
    process.env.SEARXNG_URL = 'http://localhost:8080';
    const hangingServer = http.createServer((_request, _response) => { /* waits for client cancellation */ });
    await new Promise<void>((resolve, reject) => {
      hangingServer.listen(0, '127.0.0.1', resolve);
      hangingServer.once('error', reject);
    });
    const address = hangingServer.address() as net.AddressInfo;
    const aborter = new AbortController();
    fetchMocker.mock(createMockFetch({ body: SEARXNG_RESPONSE }));
    try {
      const pending = client.callTool(
        { name: 'web_url_read', arguments: { url: `http://127.0.0.1:${address.port}` } },
        undefined,
        { signal: aborter.signal },
      );
      setTimeout(() => aborter.abort(), 20);
      await assert.rejects(pending);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const accepted = await client.callTool({ name: 'searxng_web_search', arguments: { query: 'after-cancel' } });
      assert.equal(accepted.isError, undefined);
    } finally {
      hangingServer.closeAllConnections();
      await new Promise<void>((resolve) => hangingServer.close(() => resolve()));
      fetchMocker.restore();
      if (originalPrivateUrls === undefined) delete process.env.MCP_HTTP_ALLOW_PRIVATE_URLS;
      else process.env.MCP_HTTP_ALLOW_PRIVATE_URLS = originalPrivateUrls;
      if (originalUrl === undefined) delete process.env.SEARXNG_URL;
      else process.env.SEARXNG_URL = originalUrl;
      await client.close();
    }
  }, results);

  await testFunction('client request timeout releases an admitted URL-read slot without an unhandled rejection', async () => {
    const controller = new ToolAdmissionController({ rateWindowMs: 60_000, rateMax: 4, maxInFlight: 1 });
    const { client } = await connect(controller);
    const originalPrivateUrls = process.env.MCP_HTTP_ALLOW_PRIVATE_URLS;
    const originalUrl = process.env.SEARXNG_URL;
    process.env.MCP_HTTP_ALLOW_PRIVATE_URLS = 'true';
    process.env.SEARXNG_URL = 'http://localhost:8080';
    const hangingServer = http.createServer((_request, _response) => { /* waits for request timeout */ });
    await new Promise<void>((resolve, reject) => {
      hangingServer.listen(0, '127.0.0.1', resolve);
      hangingServer.once('error', reject);
    });
    const address = hangingServer.address() as net.AddressInfo;
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    fetchMocker.mock(createMockFetch({ body: SEARXNG_RESPONSE }));
    try {
      await assert.rejects(
        client.callTool(
          { name: 'web_url_read', arguments: { url: `http://127.0.0.1:${address.port}` } },
          undefined,
          { timeout: 20 },
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      const accepted = await client.callTool({ name: 'searxng_web_search', arguments: { query: 'after-timeout' } });
      assert.equal(accepted.isError, undefined);
      assert.deepEqual(unhandled, []);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      hangingServer.closeAllConnections();
      await new Promise<void>((resolve) => hangingServer.close(() => resolve()));
      fetchMocker.restore();
      if (originalPrivateUrls === undefined) delete process.env.MCP_HTTP_ALLOW_PRIVATE_URLS;
      else process.env.MCP_HTTP_ALLOW_PRIVATE_URLS = originalPrivateUrls;
      if (originalUrl === undefined) delete process.env.SEARXNG_URL;
      else process.env.SEARXNG_URL = originalUrl;
      await client.close();
    }
  }, results);

  // ── tools/list ──────────────────────────────────────────────────────────────

  await testFunction('tools/list returns all search, discovery, and URL tools', async () => {
    const { client } = await connect();
    const result = await client.listTools();

    assert.equal(result.tools.length, 4);
    assert.ok(result.tools.find((t) => t.name === 'searxng_web_search'), 'missing searxng_web_search');
    assert.ok(result.tools.find((t) => t.name === 'searxng_search_suggestions'), 'missing searxng_search_suggestions');
    assert.ok(result.tools.find((t) => t.name === 'searxng_instance_info'), 'missing searxng_instance_info');
    assert.ok(result.tools.find((t) => t.name === 'web_url_read'), 'missing web_url_read');

    await client.close();
  }, results);

  // ── tools/list: SEARXNG_LITE_TOOLS ──────────────────────────────────────────

  await testFunction('tools/list with SEARXNG_LITE_TOOLS=true returns minimal schemas', async () => {
    process.env.SEARXNG_LITE_TOOLS = 'true';
    const { client } = await connect();
    const result = await client.listTools();

    assert.equal(result.tools.length, 4);
    const searchTool = result.tools.find((t) => t.name === 'searxng_web_search');
    const suggestionsTool = result.tools.find((t) => t.name === 'searxng_search_suggestions');
    const instanceInfoTool = result.tools.find((t) => t.name === 'searxng_instance_info');
    const readTool = result.tools.find((t) => t.name === 'web_url_read');
    assert.ok(searchTool, 'searxng_web_search must be registered');
    assert.ok(suggestionsTool, 'searxng_search_suggestions must be registered');
    assert.ok(instanceInfoTool, 'searxng_instance_info must be registered');
    assert.ok(readTool, 'web_url_read must be registered');

    const searchProps = searchTool.inputSchema.properties as Record<string, unknown>;
    assert.ok(searchProps.query, 'lite search tool must have query');
    assert.ok(!searchProps.language, 'lite search tool must NOT have language');
    assert.ok(!searchProps.safesearch, 'lite search tool must NOT have safesearch');

    const readProps = readTool.inputSchema.properties as Record<string, unknown>;
    assert.ok(readProps.url, 'lite read tool must have url');
    assert.ok(!readProps.maxLength, 'lite read tool must NOT have maxLength');

    const suggestionProps = suggestionsTool.inputSchema.properties as Record<string, unknown>;
    assert.ok(suggestionProps.query, 'lite suggestions tool must have query');
    assert.ok(!suggestionProps.language, 'lite suggestions tool must NOT have language');

    const instanceInfoProps = instanceInfoTool.inputSchema.properties as Record<string, unknown>;
    assert.equal(Object.keys(instanceInfoProps).length, 0, 'lite instance info tool must have no optional controls');

    delete process.env.SEARXNG_LITE_TOOLS;
    await client.close();
  }, results);

  await testFunction('tools/list with SEARXNG_LITE_TOOLS unset returns full schemas', async () => {
    delete process.env.SEARXNG_LITE_TOOLS;
    const { client } = await connect();
    const result = await client.listTools();

    const searchTool = result.tools.find((t) => t.name === 'searxng_web_search');
    assert.ok(searchTool);
    const searchProps = searchTool!.inputSchema.properties as Record<string, unknown>;
    assert.ok(searchProps.language, 'full search tool must have language');
    assert.ok(searchProps.safesearch, 'full search tool must have safesearch');
    const safesearchSchema = searchProps.safesearch as Record<string, unknown>;
    assert.equal(safesearchSchema.type, 'string');
    assert.deepEqual(safesearchSchema.enum, ['0', '1', '2']);
    assert.equal(safesearchSchema.default, undefined);
    assert.ok(!Object.hasOwn(safesearchSchema, 'default'));
    assert.ok(!(safesearchSchema.enum as unknown[]).some((value) => typeof value === 'number'));

    const suggestionsTool = result.tools.find((t) => t.name === 'searxng_search_suggestions');
    assert.ok(suggestionsTool);
    const suggestionProps = suggestionsTool!.inputSchema.properties as Record<string, unknown>;
    assert.ok(suggestionProps.language, 'full suggestions tool must have language');

    const instanceInfoTool = result.tools.find((t) => t.name === 'searxng_instance_info');
    assert.ok(instanceInfoTool);
    const instanceInfoProps = instanceInfoTool!.inputSchema.properties as Record<string, unknown>;
    assert.ok(instanceInfoProps.includeEngines, 'full instance info tool must have includeEngines');

    await client.close();
  }, results);

  await testFunction('tools/call searxng_web_search with SEARXNG_LITE_TOOLS=true still uses language arg', async () => {
    process.env.SEARXNG_LITE_TOOLS = 'true';
    process.env.SEARXNG_URL = 'http://localhost:8080';

    let capturedUrl = '';
    fetchMocker.mock(async (url, _opts) => {
      capturedUrl = url as string;
      const body = JSON.stringify({ results: [{ title: 'R', url: 'https://x.com', content: 'c', score: 1 }] });
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const { client } = await connect();

    await client.callTool({ name: 'searxng_web_search', arguments: { query: 'test', language: 'fr' } });

    assert.equal(new URL(capturedUrl).searchParams.get('language'), 'fr');

    fetchMocker.restore();
    delete process.env.SEARXNG_LITE_TOOLS;
    delete process.env.SEARXNG_URL;
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

  await testFunction('tools/call searxng_web_search returns prepended search metadata', async () => {
    process.env.SEARXNG_URL = 'http://localhost:8080';
    fetchMocker.mock(createMockFetch({
      body: JSON.stringify({
        answers: ['Paris'],
        suggestions: ['capital of France'],
        results: [
          {
            title: 'France Result',
            url: 'https://example.com/france',
            content: 'France snippet',
            score: 1.0,
          },
        ],
      }),
    }));
    const { client } = await connect();

    const result = await client.callTool({
      name: 'searxng_web_search',
      arguments: { query: 'capital france' },
    });

    const text = (result.content[0] as { type: string; text: string }).text;
    assert.ok(text.startsWith('Direct answer: Paris'), text);
    assert.ok(text.includes('Suggestions: capital of France'), text);
    assert.ok(text.includes('Title: France Result'), text);

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

  await testFunction('tools/call searxng_web_search accepts string safesearch and forwards numeric query param', async () => {
    process.env.SEARXNG_URL = 'http://localhost:8080';
    const { mockFetch, getCapturedUrl } = createCapturingMockFetch();
    fetchMocker.mock(mockFetch);
    const { client } = await connect();

    const result = await client.callTool({
      name: 'searxng_web_search',
      arguments: {
        query: 'test',
        safesearch: '2',
      },
    });

    assert.equal(result.content[0].type, 'text');
    const url = new URL(getCapturedUrl());
    assert.equal(url.searchParams.get('safesearch'), '2');

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

  await testFunction('tools/call searxng_web_search supports response_format=json', async () => {
    process.env.SEARXNG_URL = 'http://localhost:8080';
    fetchMocker.mock(createMockFetch({
      body: JSON.stringify({
        query: 'json test',
        number_of_results: 1,
        results: [
          {
            title: 'JSON Result',
            url: 'https://example.com/json',
            content: 'JSON snippet',
            score: 1.0,
            engines: ['google'],
          },
        ],
      }),
    }));
    const { client } = await connect();

    const result = await client.callTool({
      name: 'searxng_web_search',
      arguments: { query: 'json test', response_format: 'json' },
    });

    const payload = JSON.parse((result.content[0] as { type: string; text: string }).text);
    assert.equal(payload.query, 'json test');
    assert.equal(payload.results[0].title, 'JSON Result');
    assert.deepEqual(payload.results[0].engines, ['google']);

    fetchMocker.restore();
    delete process.env.SEARXNG_URL;
    await client.close();
  }, results);

  await testFunction('tools/call in lite mode uses the configured response default and accepts an explicit override', async () => {
    process.env.SEARXNG_URL = 'http://localhost:8080';
    process.env.SEARXNG_LITE_TOOLS = 'true';
    process.env.SEARXNG_DEFAULT_RESPONSE_FORMAT = 'json';
    fetchMocker.mock(createMockFetch({
      body: JSON.stringify({
        query: 'configured default',
        number_of_results: 1,
        results: [
          {
            title: 'Configured Default Result',
            url: 'https://example.com/configured-default',
            content: 'Configured default snippet',
            score: 1.0,
          },
        ],
      }),
    }));
    const { client } = await connect();

    try {
      const omitted = await client.callTool({
        name: 'searxng_web_search',
        arguments: { query: 'configured default omitted' },
      });
      const omittedPayload = JSON.parse((omitted.content[0] as { type: string; text: string }).text);
      assert.equal(omittedPayload.results[0].title, 'Configured Default Result');

      const explicit = await client.callTool({
        name: 'searxng_web_search',
        arguments: { query: 'configured default explicit', response_format: 'text' },
      });
      const explicitText = (explicit.content[0] as { type: string; text: string }).text;
      assert.ok(explicitText.includes('Title: Configured Default Result'), explicitText);
      assert.throws(() => JSON.parse(explicitText));
    } finally {
      fetchMocker.restore();
      delete process.env.SEARXNG_DEFAULT_RESPONSE_FORMAT;
      delete process.env.SEARXNG_LITE_TOOLS;
      delete process.env.SEARXNG_URL;
      await client.close();
    }
  }, results);

  await testFunction('full schema defaults to full and routes compact text and JSON', async () => {
    process.env.SEARXNG_URL = 'http://localhost:8080';
    fetchMocker.mock(createMockFetch({ body: JSON.stringify({
      answers: ['42'],
      results: [{ title: 'Detail', url: 'https://example.com/detail', content: 'Snippet', score: 0.5, engines: ['google'] }],
    }) }));
    const { client } = await connect();
    try {
      const omitted = await client.callTool({ name: 'searxng_web_search', arguments: { query: 'omitted full' } });
      const omittedText = (omitted.content[0] as { text: string }).text;
      assert.ok(omittedText.includes('Direct answer: 42'), omittedText);
      assert.ok(omittedText.includes('Relevance Score: 0.500'), omittedText);

      const compactText = await client.callTool({ name: 'searxng_web_search', arguments: { query: 'compact text', result_detail: 'compact' } });
      assert.equal((compactText.content[0] as { text: string }).text, 'Title: Detail\nDescription: Snippet\nURL: https://example.com/detail');

      const compactJson = await client.callTool({ name: 'searxng_web_search', arguments: { query: 'compact json', response_format: 'json', result_detail: 'compact' } });
      assert.deepEqual(JSON.parse((compactJson.content[0] as { text: string }).text), {
        results: [{ title: 'Detail', url: 'https://example.com/detail', content: 'Snippet' }],
      });
    } finally {
      fetchMocker.restore();
      delete process.env.SEARXNG_URL;
      await client.close();
    }
  }, results);

  await testFunction('tools/call in lite mode honors explicitly supplied result_detail without changing its schema', async () => {
    process.env.SEARXNG_URL = 'http://localhost:8080';
    process.env.SEARXNG_LITE_TOOLS = 'true';
    fetchMocker.mock(createMockFetch({ body: JSON.stringify({ results: [{ title: 'Lite', url: 'https://example.com/lite', content: 'Snippet', score: 1 }] }) }));
    const { client } = await connect();
    try {
      const result = await client.callTool({ name: 'searxng_web_search', arguments: { query: 'lite compact', result_detail: 'compact' } });
      assert.equal((result.content[0] as { text: string }).text, 'Title: Lite\nDescription: Snippet\nURL: https://example.com/lite');
    } finally {
      fetchMocker.restore();
      delete process.env.SEARXNG_LITE_TOOLS;
      delete process.env.SEARXNG_URL;
      await client.close();
    }
  }, results);

  await testFunction('tools/call searxng_search_suggestions returns JSON suggestions', async () => {
    process.env.SEARXNG_URL = 'http://localhost:8080';
    fetchMocker.mock(createMockFetch({ body: JSON.stringify(['type', ['typescript', 'typescript tutorial']]) }));
    const { client } = await connect();

    const result = await client.callTool({
      name: 'searxng_search_suggestions',
      arguments: { query: 'type', language: 'en' },
    });

    assert.equal(result.content[0].type, 'text');
    const payload = JSON.parse((result.content[0] as { type: string; text: string }).text);
    assert.deepEqual(payload, {
      query: 'type',
      suggestions: ['typescript', 'typescript tutorial'],
    });

    fetchMocker.restore();
    delete process.env.SEARXNG_URL;
    await client.close();
  }, results);

  await testFunction('tools/call searxng_instance_info returns JSON instance info', async () => {
    process.env.SEARXNG_URL = 'http://localhost:8080';
    fetchMocker.mock(createMockFetch({
      body: JSON.stringify({
        categories: { general: {}, news: {} },
        engines: [
          { name: 'google', categories: ['general'], disabled: false },
          { name: 'bing', categories: ['general'], disabled: true },
        ],
        search: { safe_search: 1 },
        default_theme: 'simple',
        plugins: [],
      }),
    }));
    const { client } = await connect();

    const result = await client.callTool({
      name: 'searxng_instance_info',
      arguments: { includeEngines: true, includeDisabled: true },
    });

    assert.equal(result.content[0].type, 'text');
    const payload = JSON.parse((result.content[0] as { type: string; text: string }).text);
    assert.equal(payload.available, true);
    assert.deepEqual(payload.instancesReachable, ['http://localhost:8080']);
    assert.equal(payload.sourceUrl, undefined);
    assert.deepEqual(payload.categories.common, ['general', 'news']);
    assert.deepEqual(payload.categories.available, ['general', 'news']);
    assert.deepEqual(payload.engines.common.enabled, ['google']);
    assert.deepEqual(payload.engines.available.enabled, ['google']);
    assert.deepEqual(payload.engines.common.disabled, ['bing']);
    assert.deepEqual(payload.engines.available.disabled, ['bing']);

    fetchMocker.restore();
    delete process.env.SEARXNG_URL;
    await client.close();
  }, results);

  await testFunction('tools/call searxng_web_search with invalid args throws protocol error', async () => {
    process.env.SEARXNG_DEFAULT_RESPONSE_FORMAT = 'json';
    const { client } = await connect();

    try {
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

      let fetchCount = 0;
      fetchMocker.mock(async () => {
        fetchCount++;
        throw new Error('invalid result_detail must not fetch');
      });

      try {
        await client.callTool({
          name: 'searxng_web_search',
          arguments: { query: 'invalid detail', result_detail: 'Compact' },
        });
        assert.fail('Expected invalid result_detail error was not thrown');
      } catch (error) {
        assert.ok(error instanceof Error, 'should throw an Error for invalid result_detail');
      }
      assert.equal(fetchCount, 0, 'invalid result_detail must fail before fetch');
      fetchMocker.restore();

      try {
        await client.callTool({
          name: 'searxng_web_search',
          arguments: { query: 'invalid format', response_format: 'xml' },
        });
        assert.fail('Expected invalid response_format error was not thrown');
      } catch (error) {
        assert.ok(error instanceof Error, 'should throw an Error for invalid response_format');
      }
    } finally {
      delete process.env.SEARXNG_DEFAULT_RESPONSE_FORMAT;
      await client.close();
    }
  }, results);

  await testFunction('tool errors and MCP logs never expose configured Basic Auth material', async () => {
    const originalUrl = process.env.SEARXNG_URL;
    const originalUsername = process.env.AUTH_USERNAME;
    const originalPassword = process.env.AUTH_PASSWORD;
    delete process.env.AUTH_USERNAME;
    delete process.env.AUTH_PASSWORD;
    process.env.SEARXNG_URL = 'ftp://protocol-user:protocol-secret@search.example.com/path';
    resetDiagnosticSanitizerForTests();
    initializeDiagnosticSanitizer();
    const { client, logs } = await connectWithLogs();
    let caughtError: unknown;
    let errorText = '';

    try {
      await client.callTool({
        name: 'searxng_web_search',
        arguments: { query: 'test' },
      });
    } catch (error) {
      caughtError = error;
      errorText = error instanceof Error ? `${error.message}\n${error.stack}` : String(error);
    } finally {
      await new Promise(resolve => setTimeout(resolve, 10));
      await client.close();
      if (originalUrl === undefined) delete process.env.SEARXNG_URL;
      else process.env.SEARXNG_URL = originalUrl;
      if (originalUsername === undefined) delete process.env.AUTH_USERNAME;
      else process.env.AUTH_USERNAME = originalUsername;
      if (originalPassword === undefined) delete process.env.AUTH_PASSWORD;
      else process.env.AUTH_PASSWORD = originalPassword;
      resetDiagnosticSanitizerForTests();
    }

    const output = `${errorText}\n${JSON.stringify(logs)}`;
    assert.ok(!output.includes('protocol-user'), output);
    assert.ok(!output.includes('protocol-secret'), output);
    assert.ok(output.includes('ftp:'), output);
    assert.ok(caughtError instanceof Error, 'Expected configuration error');
    assert.equal(caughtError.message, EXPECTED_PROTOCOL_ERROR_MESSAGE, output);
  }, results);

  // ── tools/call: web_url_read ─────────────────────────────────────────────────

  await testFunction('tools/call web_url_read returns markdown text', async () => {
    const { client } = await connect();

    await withPrivateUrlReadsAllowed(async () => {
      await withLocalHtmlServer(HTML_RESPONSE, async (url) => {
        const result = await client.callTool({
          name: 'web_url_read',
          arguments: { url },
        });

        assert.equal(result.content[0].type, 'text');
        assert.ok(
          (result.content[0] as { type: string; text: string }).text.length > 0,
          'result text should be non-empty'
        );
      });
    });

    await client.close();
  }, results);

  await testFunction('tools/call web_url_read with pagination options succeeds', async () => {
    const { client } = await connect();

    await withPrivateUrlReadsAllowed(async () => {
      await withLocalHtmlServer(HTML_RESPONSE, async (url) => {
        const result = await client.callTool({
          name: 'web_url_read',
          arguments: { url, startChar: 0, maxLength: 100 },
        });

        assert.equal(result.content[0].type, 'text');
      });
    });

    await client.close();
  }, results);

  await testFunction('tools/call web_url_read uses URL_READ_MAX_CHARS when maxLength is omitted', async () => {
    process.env.URL_READ_MAX_CHARS = '10';
    const { client } = await connect();

    await withPrivateUrlReadsAllowed(async () => {
      await withLocalHtmlServer(LONG_HTML_RESPONSE, async (url) => {
        const result = await client.callTool({
          name: 'web_url_read',
          arguments: { url },
        });

        const text = (result.content[0] as { type: string; text: string }).text;
        assert.ok(text.length <= 10);
        assert.ok(text.startsWith('abcde'));
      });
    });

    delete process.env.URL_READ_MAX_CHARS;
    await client.close();
  }, results);

  await testFunction('tools/call web_url_read maxLength overrides URL_READ_MAX_CHARS', async () => {
    process.env.URL_READ_MAX_CHARS = '10';
    const { client } = await connect();

    await withPrivateUrlReadsAllowed(async () => {
      await withLocalHtmlServer(LONG_HTML_RESPONSE, async (url) => {
        const result = await client.callTool({
          name: 'web_url_read',
          arguments: { url, maxLength: 5 },
        });

        const text = (result.content[0] as { type: string; text: string }).text;
        assert.ok(text.length <= 5);
        assert.ok(text.startsWith('abcde'));
      });
    });

    delete process.env.URL_READ_MAX_CHARS;
    await client.close();
  }, results);

  await testFunction('tools/call web_url_read ignores invalid URL_READ_MAX_CHARS', async () => {
    process.env.URL_READ_MAX_CHARS = '0';
    const { client } = await connect();

    await withPrivateUrlReadsAllowed(async () => {
      await withLocalHtmlServer(LONG_HTML_RESPONSE, async (url) => {
        const result = await client.callTool({
          name: 'web_url_read',
          arguments: { url },
        });

        const text = (result.content[0] as { type: string; text: string }).text;
        assert.ok(text.includes('abcdefghijklmnopqrstuvwxyz'));
      });
    });

    delete process.env.URL_READ_MAX_CHARS;
    await client.close();
  }, results);

  await testFunction('tools/call web_url_read rejects a numeric prefix with a suffix in URL_READ_MAX_CHARS', async () => {
    const originalValue = process.env.URL_READ_MAX_CHARS;
    process.env.URL_READ_MAX_CHARS = '10x';
    const { client } = await connect();

    try {
      await withPrivateUrlReadsAllowed(async () => {
        await withLocalHtmlServer(LONG_HTML_RESPONSE, async (url) => {
          const result = await client.callTool({
            name: 'web_url_read',
            arguments: { url },
          });

          const text = (result.content[0] as { type: string; text: string }).text;
          assert.ok(text.includes('abcdefghijklmnopqrstuvwxyz'), text);
        });
      });
    } finally {
      await client.close();
      if (originalValue === undefined) {
        delete process.env.URL_READ_MAX_CHARS;
      } else {
        process.env.URL_READ_MAX_CHARS = originalValue;
      }
    }
  }, results);

  await testFunction('tools/call web_url_read rejects FETCH_TIMEOUT_MS with a unit suffix', async () => {
    const originalValue = process.env.FETCH_TIMEOUT_MS;
    process.env.FETCH_TIMEOUT_MS = '10s';
    const { client, logs } = await connectWithLogs();

    try {
      await withPrivateUrlReadsAllowed(async () => {
        await withLocalHtmlServer(HTML_RESPONSE, async (url) => {
          const result = await client.callTool({
            name: 'web_url_read',
            arguments: { url },
          });
          assert.equal(result.content[0].type, 'text');
        });
      });
      const hasExpectedWarning = () => logs.some((entry: any) =>
        entry.params?.level === 'warning'
        && entry.params?.data?.message?.includes('Ignoring invalid FETCH_TIMEOUT_MS="10s"')
      );
      const deadline = Date.now() + 1000;
      while (!hasExpectedWarning() && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.ok(hasExpectedWarning(), JSON.stringify(logs));
    } finally {
      await client.close();
      if (originalValue === undefined) {
        delete process.env.FETCH_TIMEOUT_MS;
      } else {
        process.env.FETCH_TIMEOUT_MS = originalValue;
      }
    }
  }, results);

  await testFunction('tools/call web_url_read FETCH_TIMEOUT_MS=100 times out against hanging server', async () => {
    process.env.FETCH_TIMEOUT_MS = '100';
    process.env.MCP_HTTP_ALLOW_PRIVATE_URLS = 'true';
    const { client } = await connect();

    const hangingServer = http.createServer((_req, _res) => { /* never responds */ });
    await new Promise<void>((resolve, reject) => {
      hangingServer.listen(0, '127.0.0.1', resolve);
      hangingServer.once('error', reject);
    });
    const addr = hangingServer.address() as net.AddressInfo;
    const hangUrl = `http://127.0.0.1:${addr.port}`;

    const start = Date.now();
    try {
      await client.callTool({ name: 'web_url_read', arguments: { url: hangUrl } });
      assert.fail('Expected timeout error to be thrown');
    } catch (error: any) {
      const elapsed = Date.now() - start;
      // Must abort well before the default 10 s (100 ms timeout + margin)
      assert.ok(elapsed < 3000, `Expected timeout within 3 s, took ${elapsed} ms`);
      assert.ok(
        error.message.toLowerCase().includes('network') ||
        error.message.toLowerCase().includes('abort') ||
        error.message.toLowerCase().includes('timeout') ||
        error.message.toLowerCase().includes('error'),
        `Expected network/timeout error, got: ${error.message}`
      );
    }

    await new Promise<void>((resolve) => { hangingServer.closeAllConnections(); hangingServer.close(() => resolve()); });
    delete process.env.FETCH_TIMEOUT_MS;
    delete process.env.MCP_HTTP_ALLOW_PRIVATE_URLS;
    await client.close();
  }, results);

  await testFunction('tools/call web_url_read FETCH_TIMEOUT_MS default 10000 used when env unset', async () => {
    delete process.env.FETCH_TIMEOUT_MS;
    const { client } = await connect();

    await withPrivateUrlReadsAllowed(async () => {
      await withLocalHtmlServer(HTML_RESPONSE, async (url) => {
        // Normal request succeeds - confirms the default timeout path doesn't break anything
        const result = await client.callTool({ name: 'web_url_read', arguments: { url } });
        assert.equal(result.content[0].type, 'text');
        assert.ok((result.content[0] as { type: string; text: string }).text.length > 0);
      });
    });

    await client.close();
  }, results);

  await testFunction('tools/call web_url_read with readHeadings=true succeeds', async () => {
    const { client } = await connect();

    await withPrivateUrlReadsAllowed(async () => {
      await withLocalHtmlServer(HTML_RESPONSE, async (url) => {
        const result = await client.callTool({
          name: 'web_url_read',
          arguments: { url, readHeadings: true },
        });

        assert.equal(result.content[0].type, 'text');
      });
    });

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

  await testFunction('logging/setLevel and config resources stay isolated per server', async () => {
    const first = await connectWithLogs();
    const second = await connectWithLogs();

    try {
      await first.client.setLoggingLevel('debug');
      await second.client.setLoggingLevel('error');
      first.logs.length = 0;
      second.logs.length = 0;

      await first.client.listTools();
      await second.client.listTools();

      assert.ok(
        first.logs.some((entry) => JSON.stringify(entry).includes('Handling list_tools request')),
        JSON.stringify(first.logs),
      );
      assert.ok(
        !second.logs.some((entry) => JSON.stringify(entry).includes('Handling list_tools request')),
        JSON.stringify(second.logs),
      );

      const firstConfig = await first.client.readResource({ uri: 'config://server-config' });
      const secondConfig = await second.client.readResource({ uri: 'config://server-config' });
      const firstPayload = JSON.parse((firstConfig.contents[0] as { text: string }).text);
      const secondPayload = JSON.parse((secondConfig.contents[0] as { text: string }).text);

      assert.equal(firstPayload.environment.currentLogLevel, 'debug');
      assert.equal(secondPayload.environment.currentLogLevel, 'error');
    } finally {
      await first.client.close();
      await second.client.close();
    }
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

  await testFunction('resources/read errors redact credential-bearing URIs', async () => {
    const originalUrl = process.env.SEARXNG_URL;
    const markerUrl = 'https://resource-user:resource-secret@search.example.com';
    process.env.SEARXNG_URL = markerUrl;
    resetDiagnosticSanitizerForTests();
    initializeDiagnosticSanitizer();
    const { client } = await connect();
    let caughtError: unknown;
    let output = '';

    try {
      await client.readResource({ uri: markerUrl });
    } catch (error) {
      caughtError = error;
      output = error instanceof Error ? `${error.message}\n${error.stack}` : String(error);
    } finally {
      await client.close();
      if (originalUrl === undefined) delete process.env.SEARXNG_URL;
      else process.env.SEARXNG_URL = originalUrl;
      resetDiagnosticSanitizerForTests();
    }

    assert.ok(!output.includes('resource-user'), output);
    assert.ok(!output.includes('resource-secret'), output);
    assert.ok(caughtError instanceof Error, 'Expected resource error');
    assert.equal(
      caughtError.message,
      'MCP error -32603: Unknown resource: https://search.example.com/',
      output,
    );
  }, results);

  printTestSummary(results, 'MCP Handler Dispatch');
  return results;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  runTests().then((r) => process.exit(r.failed > 0 ? 1 : 0)).catch(console.error);
}

export { runTests };
