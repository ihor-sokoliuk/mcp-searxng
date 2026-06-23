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
import { createMcpServer } from '../../src/index.js';
import { FetchMocker, createCapturingMockFetch, createMockFetch } from '../helpers/mock-fetch.js';
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
      return { ok: true, json: async () => ({ results: [{ title: 'R', url: 'https://x.com', content: 'c', score: 1 }] }), text: async () => '' } as any;
    });
    const { client } = await connect();

    await client.callTool({ name: 'searxng_web_search', arguments: { query: 'test', language: 'fr' } });

    assert.ok(capturedUrl.includes('language=fr'), `Expected language=fr in URL, got: ${capturedUrl}`);

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
