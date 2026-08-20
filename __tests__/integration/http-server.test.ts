#!/usr/bin/env tsx

/**
 * Integration Tests: http-server.ts
 *
 * Uses supertest to exercise the full Express request/response cycle.
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { LOG_LEVEL_META_KEY, McpServer, isLegacyRequest } from '@modelcontextprotocol/server';
import {
  DEFAULT_STATELESS_MAX_IN_FLIGHT,
  DEFAULT_STATELESS_MAX_IN_FLIGHT_PER_IP,
  DEFAULT_STATELESS_REQUEST_TIMEOUT_MS,
  MAX_STATELESS_MAX_IN_FLIGHT,
  createHttpServer,
  missingModernProtocolHeaderError,
  resolveStatelessHttpConfig,
} from '../../src/http-server.js';
import { createMcpServer, ToolAdmissionController } from '../../src/index.js';
import { testFunction, createTestResults, printTestSummary } from '../helpers/test-utils.js';
import { EnvManager } from '../helpers/env-utils.js';
import {
  initializeDiagnosticSanitizer,
  resetDiagnosticSanitizerForTests,
} from '../../src/diagnostic-sanitizer.js';

const results = createTestResults();
const envManager = new EnvManager();

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function createTestMcpServer(): McpServer {
  return new McpServer(
    { name: 'test-server', version: '1.0.0' },
    { capabilities: { logging: {}, tools: {}, resources: {} } }
  );
}

function postStatelessMcp(
  app: Awaited<ReturnType<typeof createHttpServer>>,
  body: unknown,
  clientIp?: string,
) {
  const pending = request(app).post('/mcp')
    .set('Content-Type', 'application/json')
    .set('Accept', 'application/json, text/event-stream');
  if (clientIp) pending.set('X-Forwarded-For', clientIp);
  return pending.send(body);
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

async function assertAllowedMcpPreflight(
  app: Awaited<ReturnType<typeof createHttpServer>>,
  origin: string,
): Promise<void> {
  const options = await request(app).options('/mcp')
    .set('Origin', origin)
    .set('Access-Control-Request-Method', 'POST')
    .set('Access-Control-Request-Headers', 'Content-Type, mcp-session-id, authorization, mcp-protocol-version, mcp-method, mcp-name, x-attacker');
  assert.equal(options.status, 204);
  assert.equal(options.headers['access-control-allow-origin'], origin);
  assert.match(options.headers.vary || '', /Origin/);
  const allowHeaders = (options.headers['access-control-allow-headers'] || '').toLowerCase();
  for (const header of ['content-type', 'mcp-session-id', 'authorization', 'mcp-protocol-version', 'mcp-method', 'mcp-name']) {
    assert.ok(allowHeaders.includes(header));
  }
  assert.ok(!allowHeaders.includes('x-attacker'));
}

async function createModernHttpHarness() {
  const factoryEras: boolean[] = [];
  const app = await createHttpServer((modern) => {
    factoryEras.push(modern === true);
    return createMcpServer(new ToolAdmissionController({
      rateWindowMs: 60_000,
      rateMax: 100,
      maxInFlight: 4,
    }), modern);
  });
  const envelope = {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientCapabilities': {},
  };
  const modernPost = (body: unknown, method: string, name?: string, sessionId?: string) => {
    let pending = request(app).post('/mcp')
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json')
      .set('MCP-Protocol-Version', '2026-07-28')
      .set('MCP-Method', method);
    if (name) pending = pending.set('MCP-Name', name);
    if (sessionId) pending = pending.set('MCP-Session-Id', sessionId);
    return pending.send(body);
  };
  return { envelope, factoryEras, modernPost };
}

type ModernHttpHarness = Awaited<ReturnType<typeof createModernHttpHarness>>;

async function assertModernDiscoveryAndResources({ envelope, modernPost }: ModernHttpHarness): Promise<void> {
  const discovery = await modernPost({
    jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: envelope },
  }, 'server/discover');
  assert.equal(discovery.status, 200);
  assert.deepEqual(discovery.body.result.supportedVersions, ['2026-07-28']);

  const tools = await modernPost({
    jsonrpc: '2.0', id: 2, method: 'tools/list', params: { _meta: envelope },
  }, 'tools/list');
  assert.equal(tools.status, 200);
  assert.deepEqual(tools.body.result.tools.map((tool: { name: string }) => tool.name), [
    'searxng_web_search', 'searxng_search_suggestions', 'searxng_instance_info', 'web_url_read',
  ]);

  const resources = await modernPost({
    jsonrpc: '2.0', id: 3, method: 'resources/list', params: { _meta: envelope },
  }, 'resources/list', undefined, 'ignored-legacy-session');
  assert.equal(resources.status, 200);
  assert.equal(resources.headers['mcp-session-id'], undefined);
  assert.deepEqual(resources.body.result.resources.map((resource: { uri: string }) => resource.uri), [
    'config://server-config', 'help://usage-guide',
  ]);

  const help = await modernPost({
    jsonrpc: '2.0', id: 4, method: 'resources/read',
    params: { _meta: envelope, uri: 'help://usage-guide' },
  }, 'resources/read', 'help://usage-guide');
  assert.equal(help.status, 200);
  assert.equal(help.body.result.contents[0].uri, 'help://usage-guide');
  assert.equal(help.body.result.resultType, 'complete');
}

async function assertModernRequestLogs({ envelope, modernPost }: ModernHttpHarness): Promise<void> {
  const quietCall = await modernPost({
    jsonrpc: '2.0', id: 5, method: 'tools/call',
    params: { _meta: envelope, name: 'searxng_web_search', arguments: { query: 'quiet' } },
  }, 'tools/call', 'searxng_web_search');
  assert.equal(quietCall.status, 200);
  assert.doesNotMatch(quietCall.text, /notifications\/message/);
  assert.match(quietCall.text, /"isError":true/);
  assert.match(quietCall.text, /"resultType":"complete"/);

  const debugCall = await modernPost({
    jsonrpc: '2.0', id: 6, method: 'tools/call',
    params: {
      _meta: { ...envelope, [LOG_LEVEL_META_KEY]: 'debug' },
      name: 'searxng_web_search',
      arguments: { query: 'debug' },
    },
  }, 'tools/call', 'searxng_web_search');
  assert.equal(debugCall.status, 200);
  assert.match(debugCall.text, /notifications\/message/);
  assert.match(debugCall.text, /Handling call_tool request: searxng_web_search/);
  assert.match(debugCall.text, /"resultType":"complete"/);

  const [overlappingQuiet, overlappingDebug] = await Promise.all([
    modernPost({
      jsonrpc: '2.0', id: 7, method: 'tools/call',
      params: { _meta: envelope, name: 'searxng_web_search', arguments: { query: 'overlap-quiet' } },
    }, 'tools/call', 'searxng_web_search'),
    modernPost({
      jsonrpc: '2.0', id: 8, method: 'tools/call',
      params: {
        _meta: { ...envelope, [LOG_LEVEL_META_KEY]: 'debug' },
        name: 'searxng_web_search',
        arguments: { query: 'overlap-debug' },
      },
    }, 'tools/call', 'searxng_web_search'),
  ]);
  assert.equal(overlappingQuiet.status, 200);
  assert.doesNotMatch(overlappingQuiet.text, /notifications\/message/);
  assert.equal(overlappingDebug.status, 200);
  assert.match(overlappingDebug.text, /Handling call_tool request: searxng_web_search/);
}

async function assertModernHttpSurface(): Promise<void> {
  const harness = await createModernHttpHarness();
  await assertModernDiscoveryAndResources(harness);
  envManager.set('SEARXNG_URL', 'ftp://search.example.com');
  try {
    await assertModernRequestLogs(harness);
  } finally {
    envManager.restore();
  }
  assert.deepEqual(harness.factoryEras, [true, true, true, true, true, true, true, true]);
}

async function runTests() {
  console.log('🧪 Integration Testing: http-server.ts\n');

  await testFunction('temporary modern missing-version guard is exact and leaves every other shape to the SDK', () => {
    const body = {
      jsonrpc: '2.0', id: 7, method: 'server/discover',
      params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } },
    };
    assert.deepEqual(missingModernProtocolHeaderError({}, body), {
      id: 7,
      error: {
        code: -32020,
        message: 'Bad Request: the request headers and body disagree: the body envelope names protocol version 2026-07-28 but the required MCP-Protocol-Version header is absent',
        data: { mismatch: { header: '(missing)', body: 'the body envelope names protocol version 2026-07-28 but the required MCP-Protocol-Version header is absent' } },
      },
    });
    assert.equal(missingModernProtocolHeaderError({ 'mcp-protocol-version': ' ' }, body), undefined);
    assert.equal(missingModernProtocolHeaderError({}, [{ ...body }]), undefined);
    assert.equal(missingModernProtocolHeaderError({}, { ...body, id: undefined }), undefined);
    assert.equal(missingModernProtocolHeaderError({}, { ...body, params: {} }), undefined);
  }, results);

  await testFunction('official classifier keeps a headerless body-primary modern opening out of legacy', async () => {
    const body = {
      jsonrpc: '2.0', id: 9, method: 'server/discover',
      params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } },
    };
    const webRequest = new Request('http://localhost/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(await isLegacyRequest(webRequest, body), false);
  }, results);

  await testFunction('non-JSON legacy POST returns 415 before classification or server construction', async () => {
    let constructions = 0;
    const app = await createHttpServer(() => {
      constructions += 1;
      return createTestMcpServer();
    });
    const response = await request(app).post('/mcp')
      .set('Content-Type', 'text/plain')
      .send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }));
    assert.equal(response.status, 415);
    assert.deepEqual(response.body, {
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Unsupported Media Type' },
      id: null,
    });
    assert.equal(constructions, 0);
  }, results);

  await testFunction('temporary missing-version guard is pinned to the published server 2.0.0 package', () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed test-only installed package tripwire.
    const manifest = JSON.parse(readFileSync(
      new URL('../../node_modules/@modelcontextprotocol/server/package.json', import.meta.url),
      'utf8',
    ));
    assert.equal(
      manifest.version,
      '2.0.0',
      'SDK changed: remove this guard only after proving the stable SDK emits PR-2594 HeaderMismatch itself',
    );
  }, results);

  await testFunction(
    'modern HTTP requests compose the official handler and retain the four-tool surface',
    assertModernHttpSurface,
    results,
  );

  await testFunction('stateless HTTP configuration defaults are disabled and bounded', async () => {
    envManager.delete('MCP_HTTP_STATELESS');
    envManager.delete('MCP_HTTP_STATELESS_MAX_IN_FLIGHT');
    envManager.delete('MCP_HTTP_STATELESS_MAX_IN_FLIGHT_PER_IP');
    envManager.delete('MCP_HTTP_STATELESS_REQUEST_TIMEOUT_MS');

    try {
      assert.deepEqual(resolveStatelessHttpConfig(), {
        enabled: false,
        maxInFlight: DEFAULT_STATELESS_MAX_IN_FLIGHT,
        maxInFlightPerIp: DEFAULT_STATELESS_MAX_IN_FLIGHT_PER_IP,
        requestTimeoutMs: DEFAULT_STATELESS_REQUEST_TIMEOUT_MS,
      });
      assert.equal(DEFAULT_STATELESS_MAX_IN_FLIGHT, 16);
      assert.equal(DEFAULT_STATELESS_MAX_IN_FLIGHT_PER_IP, 8);
      assert.equal(DEFAULT_STATELESS_REQUEST_TIMEOUT_MS, 900000);
      assert.equal(MAX_STATELESS_MAX_IN_FLIGHT, 256);
    } finally {
      envManager.restore();
    }
  }, results);

  await testFunction('stateless HTTP configuration normalizes explicit boundaries in dependency order', async () => {
    envManager.set('MCP_HTTP_STATELESS', 'true');
    envManager.set('MCP_HTTP_STATELESS_MAX_IN_FLIGHT', '4');
    envManager.set('MCP_HTTP_STATELESS_MAX_IN_FLIGHT_PER_IP', '8');
    envManager.set('MCP_HTTP_STATELESS_REQUEST_TIMEOUT_MS', '1000');

    try {
      const output = await captureConsoleOutput(async () => {
        assert.deepEqual(resolveStatelessHttpConfig(), {
          enabled: true,
          maxInFlight: 4,
          maxInFlightPerIp: 4,
          requestTimeoutMs: 1000,
        });
      });
      assert.equal(output.filter(line => line.includes('MCP_HTTP_STATELESS_MAX_IN_FLIGHT_PER_IP')).length, 1);
    } finally {
      envManager.restore();
    }
  }, results);

  await testFunction('stateless HTTP configuration rejects unsafe values without echoing them', async () => {
    const unsafeGlobal = '999999999999999999999';
    const unsafeTimeout = 'timeout-secret-value';
    envManager.set('MCP_HTTP_STATELESS', 'TRUE');
    envManager.set('MCP_HTTP_STATELESS_MAX_IN_FLIGHT', unsafeGlobal);
    envManager.set('MCP_HTTP_STATELESS_MAX_IN_FLIGHT_PER_IP', '0');
    envManager.set('MCP_HTTP_STATELESS_REQUEST_TIMEOUT_MS', unsafeTimeout);

    try {
      const output = await captureConsoleOutput(async () => {
        assert.deepEqual(resolveStatelessHttpConfig(), {
          enabled: false,
          maxInFlight: DEFAULT_STATELESS_MAX_IN_FLIGHT,
          maxInFlightPerIp: DEFAULT_STATELESS_MAX_IN_FLIGHT_PER_IP,
          requestTimeoutMs: DEFAULT_STATELESS_REQUEST_TIMEOUT_MS,
        });
      });
      const combined = output.join('\n');
      assert.equal(output.filter(line => line.includes('Ignoring invalid MCP_HTTP_STATELESS')).length, 4);
      assert.ok(!combined.includes(unsafeGlobal));
      assert.ok(!combined.includes(unsafeTimeout));
    } finally {
      envManager.restore();
    }
  }, results);

  await testFunction('stateless HTTP configuration rejects exact out-of-range boundaries', async () => {
    envManager.set('MCP_HTTP_STATELESS', 'true');
    envManager.set('MCP_HTTP_STATELESS_MAX_IN_FLIGHT', '257');
    envManager.set('MCP_HTTP_STATELESS_MAX_IN_FLIGHT_PER_IP', '257');
    envManager.set('MCP_HTTP_STATELESS_REQUEST_TIMEOUT_MS', '999');

    try {
      const output = await captureConsoleOutput(async () => {
        assert.deepEqual(resolveStatelessHttpConfig(), {
          enabled: true,
          maxInFlight: DEFAULT_STATELESS_MAX_IN_FLIGHT,
          maxInFlightPerIp: DEFAULT_STATELESS_MAX_IN_FLIGHT_PER_IP,
          requestTimeoutMs: DEFAULT_STATELESS_REQUEST_TIMEOUT_MS,
        });
      });
      assert.equal(output.filter(line => line.includes('Ignoring invalid MCP_HTTP_STATELESS_')).length, 3);
    } finally {
      envManager.restore();
    }
  }, results);

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

  await testFunction('origin boundary rejects every present invalid Origin before parsers, CORS, limits, auth, or server construction', async () => {
    envManager.delete('MCP_HTTP_HARDEN');
    envManager.delete('MCP_HTTP_AUTH_TOKEN');
    envManager.delete('MCP_HTTP_ALLOWED_ORIGINS');
    envManager.delete('MCP_HTTP_STATELESS');
    envManager.set('MCP_RATE_INIT_MAX', '1');
    let constructions = 0;

    try {
      const app = await createHttpServer(() => {
        constructions += 1;
        return createTestMcpServer();
      }, 43123);
      const expected = {
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Invalid Origin header' },
        id: null,
      };
      const invalidOrigins = [
        'null',
        'not an origin',
        'http://localhost:43123,http://127.0.0.1:43123',
        'HTTP://localhost:43123',
        'http://localhost:43123/',
        '',
      ];
      const responses = await captureConsoleOutput(async () => {
        const methodResponses = await Promise.all([
          request(app).options('/MCP')
            .set('Origin', invalidOrigins[0])
            .set('Access-Control-Request-Method', 'POST'),
          request(app).post('/mcp/')
            .set('Origin', invalidOrigins[1])
            .set('Content-Type', 'application/json')
            .send('{"jsonrpc":"2.0"'),
          request(app).get('/mcp/anything').set('Origin', invalidOrigins[2]),
          request(app).delete('/mcp').set('Origin', invalidOrigins[3]),
          request(app).patch('/mcp').set('Origin', invalidOrigins[4]),
          request(app).post('/mcp').set('Origin', invalidOrigins[5]),
        ]);
        for (const res of methodResponses) {
          assert.equal(res.status, 403);
          assert.deepEqual(res.body, expected);
          assert.equal(res.headers['access-control-allow-origin'], undefined);
          assert.equal(res.headers['ratelimit-limit'], undefined);
          assert.equal(res.headers['ratelimit-remaining'], undefined);
          assert.ok(!Object.keys(res.headers).some(header => /rate-?limit/i.test(header)));
        }

        for (let attempt = 0; attempt < 3; attempt += 1) {
          const res = await request(app).post('/mcp').set('Origin', 'https://attacker.example');
          assert.equal(res.status, 403);
          assert.deepEqual(res.body, expected);
          assert.equal(res.headers['ratelimit-limit'], undefined);
        }
      });
      assert.deepEqual(responses, []);
      assert.equal(constructions, 0);

      const outside = await request(app).post('/mcp-extra')
        .set('Origin', 'https://attacker.example');
      assert.equal(outside.status, 404);
    } finally {
      envManager.restore();
    }
  }, results);

  await testFunction('stateless origin boundary rejects attacker Origins before construction in compatibility mode', async () => {
    envManager.delete('MCP_HTTP_HARDEN');
    envManager.delete('MCP_HTTP_ALLOWED_ORIGINS');
    envManager.set('MCP_HTTP_STATELESS', 'true');
    let constructions = 0;

    try {
      const app = await createHttpServer(() => {
        constructions += 1;
        return createTestMcpServer();
      }, 43123);
      const res = await request(app).post('/mcp')
        .set('Origin', 'https://attacker.example')
        .set('Content-Type', 'application/json')
        .send('{"jsonrpc":"2.0"');
      assert.equal(res.status, 403);
      assert.deepEqual(res.body, {
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Invalid Origin header' },
        id: null,
      });
      assert.equal(constructions, 0);
    } finally {
      envManager.restore();
    }
  }, results);

  await testFunction('origin boundary permits absent Origins and reflects only exact allowed Origins', async () => {
    envManager.delete('MCP_HTTP_HARDEN');
    envManager.delete('MCP_HTTP_ALLOWED_ORIGINS');

    try {
      const app = await createHttpServer(() => createTestMcpServer(), 43123);
      const allowedOrigins = [
        'http://127.0.0.1',
        'http://localhost',
        'http://[::1]',
        'https://127.0.0.1',
        'https://localhost',
        'https://[::1]',
        'http://127.0.0.1:43123',
        'http://localhost:43123',
        'http://[::1]:43123',
        'https://127.0.0.1:43123',
        'https://localhost:43123',
        'https://[::1]:43123',
      ];
      for (const allowedOrigin of allowedOrigins) {
        await assertAllowedMcpPreflight(app, allowedOrigin);
      }

      const post = await request(app).post('/mcp')
        .set('Origin', 'http://localhost:43123')
        .set('Content-Type', 'application/json')
        .set('Accept', 'application/json, text/event-stream')
        .send({
          jsonrpc: '2.0', id: 1, method: 'initialize',
          params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'origin-test', version: '1.0.0' } },
        });
      assert.equal(post.status, 200);
      assert.equal(post.headers['access-control-allow-origin'], 'http://localhost:43123');
      assert.match(post.headers.vary || '', /Origin/);

      const absent = await request(app).post('/mcp')
        .set('Content-Type', 'application/json')
        .set('Accept', 'application/json, text/event-stream')
        .send({
          jsonrpc: '2.0', id: 2, method: 'initialize',
          params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'no-origin-test', version: '1.0.0' } },
        });
      assert.equal(absent.status, 200);
    } finally {
      envManager.restore();
    }
  }, results);

  await testFunction('explicit origins replace loopback defaults and invalid Origin wins over hardened authentication', async () => {
    envManager.set('MCP_HTTP_ALLOWED_ORIGINS', 'https://app.example.com');

    try {
      const explicitApp = await createHttpServer(() => createTestMcpServer(), 43123);
      const loopback = await request(explicitApp).post('/mcp')
        .set('Origin', 'http://localhost:43123');
      assert.equal(loopback.status, 403);
      const explicitOptions = await request(explicitApp).options('/mcp')
        .set('Origin', 'https://app.example.com')
        .set('Access-Control-Request-Method', 'POST');
      assert.equal(explicitOptions.status, 204);
      assert.equal(explicitOptions.headers['access-control-allow-origin'], 'https://app.example.com');
      assert.match(explicitOptions.headers.vary || '', /Origin/);

      const explicitPost = await request(explicitApp).post('/mcp')
        .set('Origin', 'https://app.example.com')
        .set('Content-Type', 'application/json')
        .set('Accept', 'application/json, text/event-stream')
        .send({
          jsonrpc: '2.0', id: 1, method: 'initialize',
          params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'explicit-origin-test', version: '1.0.0' } },
        });
      assert.equal(explicitPost.status, 200);
      assert.equal(explicitPost.headers['access-control-allow-origin'], 'https://app.example.com');
      assert.match(explicitPost.headers.vary || '', /Origin/);

      envManager.set('MCP_HTTP_HARDEN', 'true');
      envManager.set('MCP_HTTP_AUTH_TOKEN', 'secret-token');
      const hardenedApp = await createHttpServer(() => createTestMcpServer());
      for (const authorization of [undefined, 'Bearer wrong-token']) {
        const invalidOrigin = await request(hardenedApp).post('/mcp')
          .set('Origin', 'https://attacker.example')
          .set('Content-Type', 'application/json')
          .set(authorization === undefined ? {} : { Authorization: authorization })
          .send('{"jsonrpc":"2.0"');
        assert.equal(invalidOrigin.status, 403);
        assert.deepEqual(invalidOrigin.body, {
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Invalid Origin header' },
          id: null,
        });
      }
    } finally {
      envManager.restore();
    }
  }, results);

  await testFunction('hardened mode keeps GET /health unauthenticated with fixed metadata', async () => {
    envManager.set('MCP_HTTP_HARDEN', 'true');
    envManager.set('MCP_HTTP_AUTH_TOKEN', 'secret-token');
    envManager.set('MCP_HTTP_ALLOWED_ORIGINS', 'https://app.example.com');

    try {
      const app = await createHttpServer(() => createTestMcpServer(), 3000);
      const res = await request(app)
        .get('/health')
        .set('Origin', 'https://unlisted.example.com')
        .set('Host', 'unlisted.example.com');

      assert.equal(res.status, 200);
      assert.deepEqual(
        Object.keys(res.body).sort(),
        ['server', 'status', 'transport', 'version'],
      );
      assert.equal(res.body.status, 'healthy');
      assert.equal(res.body.server, 'ihor-sokoliuk/mcp-searxng');
      assert.equal(res.body.transport, 'http');
      assert.equal(typeof res.body.version, 'string');
      assert.equal(res.headers['access-control-allow-origin'], undefined);
      assert.match(res.headers.vary || '', /Origin/);

      const allowedHealth = await request(app)
        .get('/health')
        .set('Origin', 'https://app.example.com');
      assert.equal(allowedHealth.status, 200);
      assert.equal(allowedHealth.headers['access-control-allow-origin'], 'https://app.example.com');
      assert.match(allowedHealth.headers.vary || '', /Origin/);
    } finally {
      envManager.restore();
    }
  }, results);


  await testFunction('stateless POST limiter selection uses the request body and ignores session headers', async () => {
    envManager.set('MCP_HTTP_STATELESS', 'true');
    envManager.set('MCP_RATE_INIT_MAX', '7');
    envManager.set('MCP_RATE_SESSION_MAX', '11');
    envManager.set('MCP_RATE_WINDOW_MS', '60000');

    try {
      const app = await createHttpServer(() => createTestMcpServer());
      const initRes = await request(app)
        .post('/mcp')
        .set('Content-Type', 'application/json')
        .set('Accept', 'application/json, text/event-stream')
        .set('mcp-session-id', 'stale-session')
        .send({
          jsonrpc: '2.0', id: 1, method: 'initialize',
          params: { protocolVersion: '2024-11-05', capabilities: {},
            clientInfo: { name: 'stateless-client', version: '1.0.0' } }
        });
      assert.equal(initRes.status, 200);
      assert.equal(initRes.headers['ratelimit-limit'], '7');
      assert.equal(initRes.headers['mcp-session-id'], undefined);

      const listRes = await request(app)
        .post('/mcp')
        .set('Content-Type', 'application/json')
        .set('Accept', 'application/json, text/event-stream')
        .set('mcp-session-id', 'stale-session')
        .send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
      assert.equal(listRes.status, 200);
      assert.equal(listRes.headers['ratelimit-limit'], '11');

      const batchRes = await request(app)
        .post('/mcp')
        .set('Content-Type', 'application/json')
        .set('Accept', 'application/json, text/event-stream')
        .send([{ jsonrpc: '2.0', id: 3, method: 'initialize', params: {} }]);
      assert.equal(batchRes.headers['ratelimit-limit'], '11');
    } finally {
      envManager.restore();
    }
  }, results);

  await testFunction('stateless hardened Host and Origin checks reject before server construction', async () => {
    envManager.set('MCP_HTTP_STATELESS', 'true');
    envManager.set('MCP_HTTP_HARDEN', 'true');
    envManager.set('MCP_HTTP_AUTH_TOKEN', 'secret-token');
    envManager.set('MCP_HTTP_ALLOWED_ORIGINS', 'https://allowed.example.com');
    envManager.set('MCP_HTTP_ALLOWED_HOSTS', 'allowed.example.com');
    let constructions = 0;

    try {
      const app = await createHttpServer(() => {
        constructions += 1;
        return createTestMcpServer();
      });
      const body = {
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {},
          clientInfo: { name: 'security-client', version: '1.0.0' } }
      };

      const hostRes = await request(app)
        .post('/mcp')
        .set('Host', 'blocked.example.com')
        .set('Origin', 'https://allowed.example.com')
        .set('Authorization', 'Bearer secret-token')
        .set('Content-Type', 'application/json')
        .set('Accept', 'application/json, text/event-stream')
        .send(body);
      assert.equal(hostRes.status, 403);
      assert.equal(constructions, 0);

      const originRes = await request(app)
        .post('/mcp')
        .set('Host', 'allowed.example.com')
        .set('Origin', 'https://blocked.example.com')
        .set('Authorization', 'Bearer secret-token')
        .set('Content-Type', 'application/json')
        .set('Accept', 'application/json, text/event-stream')
        .send(body);
      assert.equal(originRes.status, 403);
      assert.equal(constructions, 0);
    } finally {
      envManager.restore();
    }
  }, results);

  await testFunction('stateless malformed and oversized JSON stop before server construction', async () => {
    envManager.set('MCP_HTTP_STATELESS', 'true');
    let constructions = 0;

    try {
      const app = await createHttpServer(() => {
        constructions += 1;
        return createTestMcpServer();
      });
      const malformed = await request(app)
        .post('/mcp')
        .set('Content-Type', 'application/json')
        .send('{"jsonrpc":"2.0"');
      assert.ok(malformed.status >= 400);
      assert.equal(constructions, 0);

      const oversized = await request(app)
        .post('/mcp')
        .set('Content-Type', 'application/json')
        .send({ payload: 'x'.repeat(101 * 1024) });
      assert.ok(oversized.status >= 400);
      assert.equal(constructions, 0);
    } finally {
      envManager.restore();
    }
  }, results);

  await testFunction('stateless capacity enforces per-IP and global bounds without constructing rejected requests', async () => {
    envManager.set('MCP_HTTP_STATELESS', 'true');
    envManager.set('MCP_HTTP_STATELESS_MAX_IN_FLIGHT', '2');
    envManager.set('MCP_HTTP_STATELESS_MAX_IN_FLIGHT_PER_IP', '1');
    envManager.set('MCP_HTTP_TRUST_PROXY', '1');
    envManager.set('MCP_RATE_SESSION_MAX', '20');
    const release = createDeferred();
    const startedResolvers: Array<() => void> = [];
    let constructions = 0;
    let closes = 0;

    try {
      const app = await createHttpServer(() => {
        constructions += 1;
        const server = createTestMcpServer();
        const originalClose = server.close.bind(server);
        server.close = async () => {
          closes += 1;
          await originalClose();
        };
        server.server.setRequestHandler('tools/call', async () => {
          startedResolvers.shift()?.();
          await release.promise;
          return { content: [{ type: 'text', text: 'released' }] };
        });
        return server;
      });
      const callBody = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'hold', arguments: {} } };
      const waitForStart = () => new Promise<void>((resolve) => startedResolvers.push(resolve));

      const firstStarted = waitForStart();
      const first = postStatelessMcp(app, callBody, '198.51.100.10');
      const firstResult = first.then(response => response);
      await firstStarted;

      const sameIp = await postStatelessMcp(app, callBody, '198.51.100.10')
        .timeout({ deadline: 500 });
      assert.equal(sameIp.status, 503);
      assert.equal(sameIp.headers['retry-after'], '1');
      assert.equal(sameIp.body.error.code, -32000);
      assert.equal(sameIp.body.error.message, 'Server busy');
      assert.equal(constructions, 1);

      const secondStarted = waitForStart();
      const second = postStatelessMcp(app, { ...callBody, id: 2 }, '198.51.100.11');
      const secondResult = second.then(response => response);
      await secondStarted;

      const global = await postStatelessMcp(app, { ...callBody, id: 3 }, '198.51.100.12');
      assert.equal(global.status, 503);
      assert.equal(global.headers['retry-after'], '1');
      assert.equal(constructions, 2);

      release.resolve();
      assert.equal((await firstResult).status, 200);
      assert.equal((await secondResult).status, 200);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(closes, 2);

      const afterCleanup = await postStatelessMcp(
        app,
        { jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} },
        '198.51.100.10',
      );
      assert.equal(afterCleanup.status, 200);
      assert.equal(constructions, 3);
    } finally {
      release.resolve();
      envManager.restore();
    }
  }, results);

  await testFunction('modern handler capacity bounds live servers and returns to zero', async () => {
    envManager.set('MCP_HTTP_STATELESS_MAX_IN_FLIGHT', '2');
    envManager.set('MCP_HTTP_STATELESS_MAX_IN_FLIGHT_PER_IP', '2');
    envManager.set('MCP_HTTP_TRUST_PROXY', '1');
    const release = createDeferred();
    const startedResolvers: Array<() => void> = [];
    let live = 0;
    let peak = 0;
    let constructions = 0;

    try {
      const app = await createHttpServer(() => {
        constructions += 1;
        live += 1;
        peak = Math.max(peak, live);
        const server = createTestMcpServer();
        server.server.onclose = () => {
          live -= 1;
        };
        server.server.setRequestHandler('tools/call', async () => {
          startedResolvers.shift()?.();
          await release.promise;
          return { content: [{ type: 'text', text: 'released' }] };
        });
        return server;
      });
      const envelope = {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientCapabilities': {},
      };
      const body = (id: number) => ({
        jsonrpc: '2.0', id, method: 'tools/call',
        params: { _meta: envelope, name: 'hold', arguments: {} },
      });
      const postModern = (id: number, ip: string) => request(app).post('/mcp')
        .set('Content-Type', 'application/json')
        .set('Accept', 'application/json')
        .set('MCP-Protocol-Version', '2026-07-28')
        .set('MCP-Method', 'tools/call')
        .set('MCP-Name', 'hold')
        .set('X-Forwarded-For', ip)
        .send(body(id));
      const waitForStart = () => new Promise<void>((resolve) => startedResolvers.push(resolve));

      const firstStarted = waitForStart();
      const first = postModern(1, '198.51.100.20').then(response => response);
      await firstStarted;
      const secondStarted = waitForStart();
      const second = postModern(2, '198.51.100.21').then(response => response);
      await secondStarted;
      const rejected = await postModern(3, '198.51.100.22');
      assert.equal(rejected.status, 503);
      assert.equal(constructions, 2);
      assert.equal(peak, 2);

      release.resolve();
      assert.equal((await first).status, 200);
      assert.equal((await second).status, 200);
      for (let attempt = 0; attempt < 50 && live !== 0; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(live, 0);
    } finally {
      release.resolve();
      envManager.restore();
    }
  }, results);

  await testFunction('stateless capacity rejections consume the selected rate-limit bucket', async () => {
    envManager.set('MCP_HTTP_STATELESS', 'true');
    envManager.set('MCP_HTTP_STATELESS_MAX_IN_FLIGHT', '1');
    envManager.set('MCP_HTTP_STATELESS_MAX_IN_FLIGHT_PER_IP', '1');
    envManager.set('MCP_RATE_SESSION_MAX', '2');
    const release = createDeferred();
    const started = createDeferred();

    try {
      const app = await createHttpServer(() => {
        const server = createTestMcpServer();
        server.server.setRequestHandler('tools/call', async () => {
          started.resolve();
          await release.promise;
          return { content: [{ type: 'text', text: 'released' }] };
        });
        return server;
      });
      const body = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'hold', arguments: {} } };
      const firstResult = request(app).post('/mcp')
        .set('Content-Type', 'application/json')
        .set('Accept', 'application/json, text/event-stream')
        .send(body)
        .then(response => response);
      await started.promise;

      const busy = await request(app).post('/mcp')
        .set('Content-Type', 'application/json')
        .set('Accept', 'application/json, text/event-stream')
        .send({ ...body, id: 2 });
      assert.equal(busy.status, 503);

      const rateLimited = await request(app).post('/mcp')
        .set('Content-Type', 'application/json')
        .set('Accept', 'application/json, text/event-stream')
        .send({ ...body, id: 3 });
      assert.equal(rateLimited.status, 429);
      assert.equal(rateLimited.body.error.code, -32029);

      release.resolve();
      assert.equal((await firstResult).status, 200);
    } finally {
      release.resolve();
      envManager.restore();
    }
  }, results);

  await testFunction('stateless capacity warnings aggregate to one per minute per process', async () => {
    envManager.set('MCP_HTTP_STATELESS', 'true');
    envManager.set('MCP_HTTP_STATELESS_MAX_IN_FLIGHT', '1');
    envManager.set('MCP_HTTP_STATELESS_MAX_IN_FLIGHT_PER_IP', '1');
    envManager.set('MCP_RATE_SESSION_MAX', '10');
    const release = createDeferred();
    const started = createDeferred();

    try {
      const app = await createHttpServer(() => {
        const server = createTestMcpServer();
        server.server.setRequestHandler('tools/call', async () => {
          started.resolve();
          await release.promise;
          return { content: [{ type: 'text', text: 'released' }] };
        });
        return server;
      });
      const body = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'hold', arguments: {} } };
      const firstResult = request(app).post('/mcp')
        .set('Content-Type', 'application/json')
        .set('Accept', 'application/json, text/event-stream')
        .send(body)
        .then(response => response);
      await started.promise;

      const output = await captureConsoleOutput(async () => {
        for (let id = 2; id <= 4; id += 1) {
          const busy = await request(app).post('/mcp')
            .set('Content-Type', 'application/json')
            .set('Accept', 'application/json, text/event-stream')
            .send({ ...body, id });
          assert.equal(busy.status, 503);
        }
      });
      assert.equal(output.filter(line => line.includes('Stateless HTTP capacity exhausted')).length, 1);

      release.resolve();
      assert.equal((await firstResult).status, 200);
    } finally {
      release.resolve();
      envManager.restore();
    }
  }, results);

  await testFunction('stateless request timeout returns the exact 504 contract and restores capacity', async () => {
    envManager.set('MCP_HTTP_STATELESS', 'true');
    envManager.set('MCP_HTTP_STATELESS_MAX_IN_FLIGHT', '1');
    envManager.set('MCP_HTTP_STATELESS_MAX_IN_FLIGHT_PER_IP', '1');
    envManager.set('MCP_HTTP_STATELESS_REQUEST_TIMEOUT_MS', '1000');
    const never = new Promise<void>(() => undefined);
    let constructions = 0;

    try {
      const app = await createHttpServer(() => {
        constructions += 1;
        const server = createTestMcpServer();
        if (constructions === 1) {
          server.connect = async () => {
            await never;
          };
        }
        return server;
      });
      const timedOut = await request(app).post('/mcp')
        .set('Content-Type', 'application/json')
        .set('Accept', 'application/json, text/event-stream')
        .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'hold', arguments: {} } })
        .timeout({ deadline: 2000 });
      assert.equal(timedOut.status, 504);
      assert.equal(timedOut.headers['retry-after'], undefined);
      assert.deepEqual(timedOut.body, {
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Stateless request timed out' },
        id: null,
      });

      const afterTimeout = await request(app).post('/mcp')
        .set('Content-Type', 'application/json')
        .set('Accept', 'application/json, text/event-stream')
        .send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
      assert.equal(afterTimeout.status, 200);
      assert.equal(constructions, 2);
    } finally {
      envManager.restore();
    }
  }, results);

  await testFunction('stateless lifetime includes synchronous server construction time', async () => {
    envManager.set('MCP_HTTP_STATELESS', 'true');
    envManager.set('MCP_HTTP_STATELESS_MAX_IN_FLIGHT', '1');
    envManager.set('MCP_HTTP_STATELESS_MAX_IN_FLIGHT_PER_IP', '1');
    envManager.set('MCP_HTTP_STATELESS_REQUEST_TIMEOUT_MS', '1000');
    let constructions = 0;

    try {
      const app = await createHttpServer(() => {
        constructions += 1;
        if (constructions === 1) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1050);
        }
        return createTestMcpServer();
      });
      const timedOut = await request(app).post('/mcp')
        .set('Content-Type', 'application/json')
        .set('Accept', 'application/json, text/event-stream')
        .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
      assert.equal(timedOut.status, 504);
      assert.equal(timedOut.body.error.message, 'Stateless request timed out');

      const recovered = await request(app).post('/mcp')
        .set('Content-Type', 'application/json')
        .set('Accept', 'application/json, text/event-stream')
        .send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
      assert.equal(recovered.status, 200);
      assert.equal(constructions, 2);
    } finally {
      envManager.restore();
    }
  }, results);

  await testFunction('stateless timeout closes an already-started POST stream and restores capacity', async () => {
    envManager.set('MCP_HTTP_STATELESS', 'true');
    envManager.set('MCP_HTTP_STATELESS_MAX_IN_FLIGHT', '1');
    envManager.set('MCP_HTTP_STATELESS_MAX_IN_FLIGHT_PER_IP', '1');
    envManager.set('MCP_HTTP_STATELESS_REQUEST_TIMEOUT_MS', '1000');
    let constructions = 0;
    let abortObserved = false;
    let closes = 0;

    try {
      const app = await createHttpServer(() => {
        constructions += 1;
        const server = createTestMcpServer();
        if (constructions === 1) {
          const originalClose = server.close.bind(server);
          server.close = async () => {
            closes += 1;
            await originalClose();
          };
          server.server.setRequestHandler('tools/call', async (_request, extra) => {
            await new Promise<void>((resolve) => {
              if (extra.mcpReq.signal.aborted) {
                abortObserved = true;
                resolve();
                return;
              }
              extra.mcpReq.signal.addEventListener('abort', () => {
                abortObserved = true;
                resolve();
              }, { once: true });
            });
            return { content: [{ type: 'text', text: 'aborted' }] };
          });
        }
        return server;
      });
      let streamError = '';
      let timeoutResponse: request.Response | undefined;
      try {
        timeoutResponse = await request(app).post('/mcp')
          .set('Content-Type', 'application/json')
          .set('Accept', 'application/json, text/event-stream')
          .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'hold', arguments: {} } })
          .timeout({ deadline: 2000 });
      } catch (error) {
        streamError = error instanceof Error ? error.message : String(error);
      }
      if (timeoutResponse) {
        if (timeoutResponse.status === 504) {
          assert.deepEqual(timeoutResponse.body, {
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Stateless request timed out' },
            id: null,
          });
        } else {
          assert.equal(timeoutResponse.status, 200);
          assert.doesNotMatch(timeoutResponse.text, /"(?:result|error)"\s*:/);
          const stream = timeoutResponse.res as { complete?: boolean; aborted?: boolean; destroyed?: boolean };
          assert.ok(stream.complete === false || stream.aborted === true || stream.destroyed === true);
        }
      } else {
        assert.match(streamError, /aborted|socket hang up/i);
      }
      await new Promise(resolve => setTimeout(resolve, 50));
      assert.equal(abortObserved, true);
      assert.equal(closes, 1);

      const afterTimeout = await request(app).post('/mcp')
        .set('Content-Type', 'application/json')
        .set('Accept', 'application/json, text/event-stream')
        .send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
      assert.equal(afterTimeout.status, 200);
      assert.equal(constructions, 2);
    } finally {
      envManager.restore();
    }
  }, results);

  await testFunction('stateless construction failures restore capacity', async () => {
    envManager.set('MCP_HTTP_STATELESS', 'true');
    envManager.set('MCP_HTTP_STATELESS_MAX_IN_FLIGHT', '1');
    envManager.set('MCP_HTTP_STATELESS_MAX_IN_FLIGHT_PER_IP', '1');
    let constructions = 0;

    try {
      const app = await createHttpServer(() => {
        constructions += 1;
        if (constructions === 1) throw new Error('controlled construction failure');
        return createTestMcpServer();
      });
      const failed = await request(app).post('/mcp')
        .set('Content-Type', 'application/json')
        .set('Accept', 'application/json, text/event-stream')
        .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
      assert.equal(failed.status, 500);

      const recovered = await request(app).post('/mcp')
        .set('Content-Type', 'application/json')
        .set('Accept', 'application/json, text/event-stream')
        .send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
      assert.equal(recovered.status, 200);
      assert.equal(constructions, 2);
    } finally {
      envManager.restore();
    }
  }, results);

  await testFunction('stateless cleanup wait is bounded and reclaims capacity exactly once', async () => {
    envManager.set('MCP_HTTP_STATELESS', 'true');
    envManager.set('MCP_HTTP_STATELESS_MAX_IN_FLIGHT', '1');
    envManager.set('MCP_HTTP_STATELESS_MAX_IN_FLIGHT_PER_IP', '1');
    envManager.set('MCP_RATE_SESSION_MAX', '20');
    const closeStarted = createDeferred();
    const never = new Promise<void>(() => undefined);
    let constructions = 0;
    let closeAttempts = 0;

    try {
      const app = await createHttpServer(() => {
        constructions += 1;
        const server = createTestMcpServer();
        if (constructions === 1) {
          server.close = async () => {
            closeAttempts += 1;
            closeStarted.resolve();
            await never;
          };
        }
        return server;
      });
      const first = await request(app).post('/mcp')
        .set('Content-Type', 'application/json')
        .set('Accept', 'application/json, text/event-stream')
        .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
      assert.equal(first.status, 200);
      await closeStarted.promise;

      const busy = await request(app).post('/mcp')
        .set('Content-Type', 'application/json')
        .set('Accept', 'application/json, text/event-stream')
        .send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
      assert.equal(busy.status, 503);
      await new Promise(resolve => setTimeout(resolve, 5300));

      const recovered = await request(app).post('/mcp')
        .set('Content-Type', 'application/json')
        .set('Accept', 'application/json, text/event-stream')
        .send({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} });
      assert.equal(recovered.status, 200);
      assert.equal(constructions, 2);
      assert.equal(closeAttempts, 1);
    } finally {
      envManager.restore();
    }
  }, results);

  await testFunction('stateless client disconnect aborts handler work and restores capacity', async () => {
    envManager.set('MCP_HTTP_STATELESS', 'true');
    envManager.set('MCP_HTTP_STATELESS_MAX_IN_FLIGHT', '1');
    envManager.set('MCP_HTTP_STATELESS_MAX_IN_FLIGHT_PER_IP', '1');
    const handlerStarted = createDeferred();
    const handlerAborted = createDeferred();
    let constructions = 0;
    let closes = 0;

    try {
      const app = await createHttpServer(() => {
        constructions += 1;
        const server = createTestMcpServer();
        if (constructions === 1) {
          const originalClose = server.close.bind(server);
          server.close = async () => {
            closes += 1;
            await originalClose();
          };
          server.server.setRequestHandler('tools/call', async (_request, extra) => {
            handlerStarted.resolve();
            await new Promise<void>((resolve) => {
              extra.mcpReq.signal.addEventListener('abort', () => {
                handlerAborted.resolve();
                resolve();
              }, { once: true });
            });
            return { content: [{ type: 'text', text: 'aborted' }] };
          });
        }
        return server;
      });
      const pending = request(app).post('/mcp')
        .set('Content-Type', 'application/json')
        .set('Accept', 'application/json, text/event-stream')
        .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'hold', arguments: {} } });
      const pendingResult = pending.then(
        response => response,
        error => error,
      );
      await handlerStarted.promise;
      pending.abort();
      await handlerAborted.promise;
      await pendingResult;
      await new Promise(resolve => setTimeout(resolve, 50));

      const recovered = await request(app).post('/mcp')
        .set('Content-Type', 'application/json')
        .set('Accept', 'application/json, text/event-stream')
        .send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
      assert.equal(recovered.status, 200);
      assert.equal(constructions, 2);
      assert.equal(closes, 1);
    } finally {
      envManager.restore();
    }
  }, results);

  await testFunction('stateless GET and DELETE keep the session limiter and return the exact 405 contract', async () => {
    envManager.set('MCP_HTTP_STATELESS', 'true');
    envManager.set('MCP_RATE_SESSION_MAX', '2');
    envManager.set('MCP_RATE_WINDOW_MS', '60000');

    try {
      const app = await createHttpServer(() => createTestMcpServer());
      for (const method of ['get', 'delete'] as const) {
        const res = await request(app)[method]('/mcp');
        assert.equal(res.status, 405);
        assert.equal(res.headers.allow, 'POST');
        assert.equal(res.headers['ratelimit-limit'], '2');
        assert.deepEqual(res.body, {
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Method not allowed' },
          id: null,
        });
      }

      const blocked = await request(app).get('/mcp');
      assert.equal(blocked.status, 429);
      assert.equal(blocked.body.error.code, -32029);
    } finally {
      envManager.restore();
    }
  }, results);

  await testFunction('stateless GET rejects unauthorized and invalid hardened headers before 405', async () => {
    envManager.set('MCP_HTTP_STATELESS', 'true');
    envManager.set('MCP_HTTP_HARDEN', 'true');
    envManager.set('MCP_HTTP_AUTH_TOKEN', 'secret-token');
    envManager.set('MCP_HTTP_ALLOWED_ORIGINS', 'https://allowed.example.com');
    envManager.set('MCP_HTTP_ALLOWED_HOSTS', 'allowed.example.com');

    try {
      const app = await createHttpServer(() => createTestMcpServer());
      const unauthorized = await request(app)
        .get('/mcp')
        .set('Host', 'allowed.example.com')
        .set('Origin', 'https://allowed.example.com');
      assert.equal(unauthorized.status, 401);

      const invalidHost = await request(app)
        .get('/mcp')
        .set('Host', 'blocked.example.com')
        .set('Origin', 'https://allowed.example.com')
        .set('Authorization', 'Bearer secret-token');
      assert.equal(invalidHost.status, 403);

      const invalidOrigin = await request(app)
        .delete('/mcp')
        .set('Host', 'allowed.example.com')
        .set('Origin', 'https://blocked.example.com')
        .set('Authorization', 'Bearer secret-token');
      assert.equal(invalidOrigin.status, 403);
    } finally {
      envManager.restore();
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

  await testFunction('HTTP initialization failures redact response and stderr diagnostics', async () => {
    envManager.set(
      'SEARXNG_URL',
      'https://connect-user:connect-secret@search.example.com',
    );
    resetDiagnosticSanitizerForTests();
    initializeDiagnosticSanitizer();
    const app = await createHttpServer(() => {
      throw new Error('connect failed for connect-user:connect-secret');
    });
    let response: request.Response | undefined;
    const output = await captureConsoleOutput(async () => {
      response = await request(app)
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
            clientInfo: { name: 'test-client', version: '1.0.0' },
          },
        });
    });

    const combined = `${response?.text}\n${output.join('\n')}`;
    assert.equal(response?.status, 500);
    assert.ok(!combined.includes('connect-user'), combined);
    assert.ok(!combined.includes('connect-secret'), combined);
    resetDiagnosticSanitizerForTests();
    envManager.restore();
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

  await testFunction('hardened mode rejects the undocumented raw authorization token', async () => {
    envManager.set('MCP_HTTP_HARDEN', 'true');
    envManager.set('MCP_HTTP_AUTH_TOKEN', 'secret-token');
    envManager.set('MCP_HTTP_ALLOWED_ORIGINS', 'https://app.example.com');

    const app = await createHttpServer(() => createTestMcpServer());
    const res = await request(app)
      .post('/mcp')
      .set('Origin', 'https://app.example.com')
      .set('Authorization', 'secret-token')
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
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, -32001);
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
    envManager.set('MCP_HTTP_ALLOWED_HOSTS', 'allowed.example.com');

    const app = await createHttpServer(() => createTestMcpServer(), 3000);
    const res = await request(app)
      .post('/mcp')
      .set('Host', 'evil.example.com') // explicit disallowed Host so the 403 is deterministic across supertest/node versions
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
    assert.equal(res.body.error.message, 'Invalid Host header');
    assert.equal(res.text.includes('evil.example.com'), false);
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

  await testFunction('Rate limiting: production construction parses each configured variable once', async () => {
    envManager.set('MCP_RATE_WINDOW_MS', '50ms');
    envManager.set('MCP_RATE_INIT_MAX', '1e3');
    envManager.set('MCP_RATE_SESSION_MAX', '0x10');

    try {
      const output = await captureConsoleOutput(async () => {
        await createHttpServer(() => createTestMcpServer());
      });
      const warnings = output.filter(line => line.includes('Ignoring invalid MCP_RATE_'));

      assert.deepEqual(warnings, [
        '⚠️  Ignoring invalid MCP_RATE_WINDOW_MS. Expected a positive integer. Using default 60000.',
        '⚠️  Ignoring invalid MCP_RATE_INIT_MAX. Expected a positive integer. Using default 20.',
        '⚠️  Ignoring invalid MCP_RATE_SESSION_MAX. Expected a positive integer. Using default 300.',
      ]);
    } finally {
      envManager.restore();
    }
  }, results);

  await testFunction('Rate limiting: established-session POSTs use only the session limiter', async () => {
    envManager.set('MCP_RATE_INIT_MAX', '2');
    envManager.set('MCP_RATE_SESSION_MAX', '3');
    envManager.set('MCP_RATE_WINDOW_MS', '60000');
    const app = await createHttpServer(() => createTestMcpServer());

    const initRes = await request(app)
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .send({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {},
          clientInfo: { name: 'rate-limit-client', version: '1.0.0' } }
      });
    assert.equal(initRes.status, 200);
    assert.equal(initRes.headers['ratelimit-limit'], '2');
    const sessionId = initRes.headers['mcp-session-id'];
    assert.ok(sessionId, 'initialize should return a session id');

    for (let id = 2; id <= 4; id++) {
      const res = await request(app)
        .post('/mcp')
        .set('Content-Type', 'application/json')
        .set('Accept', 'application/json, text/event-stream')
        .set('mcp-session-id', sessionId)
        .send({ jsonrpc: '2.0', id, method: 'tools/list', params: {} });
      assert.equal(res.status, 200, `Established-session request ${id - 1} should succeed`);
      assert.equal(res.headers['ratelimit-limit'], '3');
    }

    const blocked = await request(app)
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .set('mcp-session-id', sessionId)
      .send({ jsonrpc: '2.0', id: 5, method: 'tools/list', params: {} });
    envManager.restore();

    assert.equal(blocked.status, 429);
    assert.equal(blocked.headers['ratelimit-limit'], '3');
    assert.equal(blocked.body.error.code, -32029);
  }, results);

  await testFunction('Rate limiting: non-live session identifiers use the init limiter', async () => {
    envManager.set('MCP_RATE_INIT_MAX', '7');
    envManager.set('MCP_RATE_SESSION_MAX', '11');
    envManager.set('MCP_RATE_WINDOW_MS', '60000');
    const app = await createHttpServer(() => createTestMcpServer());
    const headers: Array<string | undefined> = [undefined, '', 'first, second'];

    for (const sessionId of headers) {
      let pending = request(app).post('/mcp').set('Content-Type', 'application/json');
      if (sessionId !== undefined) pending = pending.set('mcp-session-id', sessionId);
      const res = await pending.send({ jsonrpc: '2.0', method: 'tools/list', id: 1 });
      assert.equal(res.headers['ratelimit-limit'], '7');
    }

    envManager.restore();
  }, results);

  await testFunction('Rate limiting: unknown-session POSTs exhaust the init limiter', async () => {
    envManager.set('MCP_RATE_INIT_MAX', '2');
    envManager.set('MCP_RATE_SESSION_MAX', '10');
    envManager.set('MCP_RATE_WINDOW_MS', '60000');
    const app = await createHttpServer(() => createTestMcpServer());

    for (let id = 1; id <= 2; id++) {
      const res = await request(app)
        .post('/mcp')
        .set('Content-Type', 'application/json')
        .set('mcp-session-id', 'plausible-unknown-session')
        .send({ jsonrpc: '2.0', method: 'tools/list', id });
      assert.equal(res.status, 404);
      assert.equal(res.headers['ratelimit-limit'], '2');
    }

    const blocked = await request(app)
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .set('mcp-session-id', 'plausible-unknown-session')
      .send({ jsonrpc: '2.0', method: 'tools/list', id: 3 });
    envManager.restore();

    assert.equal(blocked.status, 429);
    assert.equal(blocked.headers['ratelimit-limit'], '2');
    assert.equal(blocked.body.error.code, -32029);
  }, results);

  await testFunction('Rate limiting: stale-header initialize stays on the init limiter', async () => {
    envManager.set('MCP_RATE_INIT_MAX', '2');
    envManager.set('MCP_RATE_SESSION_MAX', '10');
    envManager.set('MCP_RATE_WINDOW_MS', '60000');
    const app = await createHttpServer(() => createTestMcpServer());
    const staleId = 'stale-session-id';
    const initializeBody = (id: number) => ({
      jsonrpc: '2.0', id, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {},
        clientInfo: { name: 'stale-client', version: '1.0.0' } }
    });

    for (let id = 1; id <= 2; id++) {
      const res = await request(app)
        .post('/mcp')
        .set('Content-Type', 'application/json')
        .set('Accept', 'application/json, text/event-stream')
        .set('mcp-session-id', staleId)
        .send(initializeBody(id));
      assert.equal(res.status, 200);
      assert.equal(res.headers['ratelimit-limit'], '2');
      assert.ok(res.headers['mcp-session-id']);
      assert.notEqual(res.headers['mcp-session-id'], staleId);
    }

    const blocked = await request(app)
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .set('mcp-session-id', staleId)
      .send(initializeBody(3));
    envManager.restore();

    assert.equal(blocked.status, 429);
    assert.equal(blocked.headers['ratelimit-limit'], '2');
    assert.equal(blocked.body.error.code, -32029);
  }, results);

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

  await testFunction('Rate limiting: /health keeps its independent fixed limit of 60', async () => {
    envManager.set('MCP_RATE_WINDOW_MS', '120000');
    envManager.set('MCP_RATE_INIT_MAX', '2');
    envManager.set('MCP_RATE_SESSION_MAX', '3');

    try {
      const app = await createHttpServer(() => createTestMcpServer());
      const res = await request(app).get('/health');
      const limit = res.headers['ratelimit-limit'] || res.headers['x-ratelimit-limit'];
      const remaining = res.headers['ratelimit-remaining'] || res.headers['x-ratelimit-remaining'];

      assert.equal(limit, '60', 'health limit must remain fixed at 60 per minute');
      assert.ok(remaining, 'RateLimit-Remaining header should be present on /health');
    } finally {
      envManager.restore();
    }
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
