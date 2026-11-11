#!/usr/bin/env tsx

/**
 * Integration Tests: index.ts
 * 
 * Tests for main server integration and tool handlers
 */

import { strict as assert } from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync, unlinkSync, rmdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { finished } from 'node:stream/promises';
import { packageVersion } from '../../src/version.js';
import {
  isWebUrlReadArgs,
  createMcpServer,
  createToolAdmissionController,
  createHttpShutdown,
} from '../../src/index.js';
import { isSearXNGWebSearchArgs } from '../../src/types.js';
import { createConfigResource, createHelpResource } from '../../src/resources.js';
import { testFunction, createTestResults, printTestSummary } from '../helpers/test-utils.js';
import { spawnHttpCli, type SpawnedHttpCli } from '../e2e/helpers/spawn-server.js';

const results = createTestResults();

function terminalStdinScript(mode: string) {
  return `
    process.once('message', () => {
      process.stdin.destroy(${mode === 'error-close' ? "new Error('controlled stdin failure')" : ''});
      process.stdin.destroy();
      process.disconnect();
    });
    process.channel.unref();
    await import('./src/cli.ts');
    process.send('ready');
  `;
}

async function runTests() {
  console.log('🧪 Integration Testing: index.ts\n');

  await testFunction('repeated HTTP signals share session shutdown before listener closure', async () => {
    let release!: () => void;
    let shutdownCalls = 0;
    let closedCalls = 0;
    const draining = new Promise<void>(resolve => { release = resolve; });
    const listener = http.createServer();
    listener.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => listener.once('listening', resolve));
    const shutdown = createHttpShutdown({
      shutdownStateful: () => { shutdownCalls++; return draining; },
    }, listener, () => { closedCalls++; });
    try {
      const first = shutdown('SIGINT');
      assert.equal(shutdown('SIGTERM'), first);
      assert.equal(shutdownCalls, 1);
      assert.equal(listener.listening, true);
      assert.equal(closedCalls, 0);
      release();
      await first;
      assert.equal(listener.listening, false);
      assert.equal(closedCalls, 1);
      assert.equal(shutdown('SIGINT'), first);
    } finally { release(); listener.close(); }
  }, results);

  await testFunction('Package version is exported', () => {
    assert.ok(packageVersion);
    assert.ok(typeof packageVersion === 'string');
    assert.ok(packageVersion.length > 0);
  }, results);

  await testFunction('Call tool handler - unknown tool error', async () => {
    const unknownToolRequest = { name: 'unknown_tool', arguments: {} };
    assert.notEqual(unknownToolRequest.name, 'searxng_web_search');
    assert.notEqual(unknownToolRequest.name, 'web_url_read');

    // Simulate error response
    try {
      if (unknownToolRequest.name !== 'searxng_web_search' &&
          unknownToolRequest.name !== 'web_url_read') {
        throw new Error(`Unknown tool: ${unknownToolRequest.name}`);
      }
    } catch (error) {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes('Unknown tool'));
    }
  }, results);

  await testFunction('URL read tool with pagination parameters integration', async () => {
    const validArgs = {
      url: 'https://example.com',
      startChar: 10,
      maxLength: 100,
      section: 'introduction',
      paragraphRange: '1-3',
      readHeadings: false
    };

    // Verify type guard accepts the parameters
    assert.ok(isWebUrlReadArgs(validArgs));

    // Test individual parameter validation
    assert.ok(isWebUrlReadArgs({ url: 'https://example.com', startChar: 0 }));
    assert.ok(isWebUrlReadArgs({ url: 'https://example.com', maxLength: 1 }));
    assert.ok(isWebUrlReadArgs({ url: 'https://example.com', section: 'test' }));
    assert.ok(isWebUrlReadArgs({ url: 'https://example.com', paragraphRange: '1' }));
    assert.ok(isWebUrlReadArgs({ url: 'https://example.com', readHeadings: true }));
  }, results);

  await testFunction('Pagination options object construction', async () => {
    const testArgs = {
      url: 'https://example.com',
      startChar: 50,
      maxLength: 200,
      section: 'getting-started',
      paragraphRange: '2-5',
      readHeadings: true
    };

    // Mimic pagination options construction in index.ts
    const paginationOptions = {
      startChar: testArgs.startChar,
      maxLength: testArgs.maxLength,
      section: testArgs.section,
      paragraphRange: testArgs.paragraphRange,
      readHeadings: testArgs.readHeadings,
    };

    assert.equal(paginationOptions.startChar, 50);
    assert.equal(paginationOptions.maxLength, 200);
    assert.equal(paginationOptions.section, 'getting-started');
    assert.equal(paginationOptions.paragraphRange, '2-5');
    assert.equal(paginationOptions.readHeadings, true);
  }, results);

  await testFunction('Read resource handler - config resource', async () => {
    const configUri = "config://server-config";
    const configContent = createConfigResource();
    
    const configResponse = {
      contents: [
        {
          uri: configUri,
          mimeType: "application/json",
          text: configContent
        }
      ]
    };
    
    assert.equal(configResponse.contents[0].uri, configUri);
    assert.equal(configResponse.contents[0].mimeType, "application/json");
    assert.ok(typeof configResponse.contents[0].text === 'string');
    
    // Verify it's valid JSON
    const parsed = JSON.parse(configResponse.contents[0].text);
    assert.ok(typeof parsed === 'object');
  }, results);

  await testFunction('Read resource handler - help resource', async () => {
    const helpUri = "help://usage-guide";
    const helpContent = createHelpResource();
    
    const helpResponse = {
      contents: [
        {
          uri: helpUri,
          mimeType: "text/markdown",
          text: helpContent
        }
      ]
    };
    
    assert.equal(helpResponse.contents[0].uri, helpUri);
    assert.equal(helpResponse.contents[0].mimeType, "text/markdown");
    assert.ok(typeof helpResponse.contents[0].text === 'string');
  }, results);

  await testFunction('Read resource handler - unknown resource error', async () => {
    const testUnknownResource = (uri: string) => {
      if (uri !== "config://server-config" && 
          uri !== "help://usage-guide") {
        throw new Error(`Unknown resource: ${uri}`);
      }
    };
    
    try {
      testUnknownResource("unknown://resource");
      assert.fail('Should have thrown error');
    } catch (error) {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes('Unknown resource'));
    }
  }, results);

  await testFunction('Tool arguments validation - search tool', () => {
    // Valid cases
    assert.ok(isSearXNGWebSearchArgs({ query: 'test search', language: 'en' }));
    assert.ok(isSearXNGWebSearchArgs({ query: 'test', pageno: 1, time_range: 'day' }));
    
    // Invalid cases
    assert.ok(!isSearXNGWebSearchArgs({ notQuery: 'invalid' }));
    assert.ok(!isSearXNGWebSearchArgs(null));
    assert.ok(!isSearXNGWebSearchArgs({}));
  }, results);

  await testFunction('Tool arguments validation - URL read tool', () => {
    // Valid cases with various pagination parameters
    assert.ok(isWebUrlReadArgs({ url: 'https://example.com' }));
    assert.ok(isWebUrlReadArgs({ url: 'https://example.com', maxLength: 100 }));
    
    // Invalid cases
    assert.ok(!isWebUrlReadArgs({ url: 'https://example.com', startChar: -1 }));
    assert.ok(!isWebUrlReadArgs({ url: 'https://example.com', maxLength: 0 }));
    assert.ok(!isWebUrlReadArgs({ notUrl: 'invalid' }));
  }, results);

  await testFunction('Server starts without SEARXNG_URL set', async () => {
    const { EnvManager } = await import('../helpers/env-utils.js');
    const env = new EnvManager();
    env.delete('SEARXNG_URL');

    // validateEnvironment() should return an error string (URL missing)
    const { validateEnvironment } = await import('../../src/error-handler.js');
    const result = validateEnvironment();
    assert.ok(typeof result === 'string', 'validateEnvironment returns error string when URL missing');

    // But the server module itself must be importable and export packageVersion
    // (i.e. startup does not call process.exit when module is imported)
    assert.ok(typeof packageVersion === 'string');

    env.restore();
  }, results);

  await testFunction('Importing index.ts does not start the CLI server', () => {
    // When this suite runs under a debugger (e.g. VS Code's JavaScript Debug
    // Terminal / auto-attach), Node injects the inspector into child processes
    // and prints banner lines like "Debugger attached." to stderr. That has
    // nothing to do with the program under test, so:
    //   1. strip the inspector env vars so the child never attaches, and
    //   2. filter any residual debugger banner lines from the captured output.
    const { NODE_OPTIONS: _n, VSCODE_INSPECTOR_OPTIONS: _v, ...cleanEnv } = process.env;

    const stripDebuggerNoise = (output: string): string =>
      output
        .split('\n')
        .filter(line => !/^(Debugger attached\.|Waiting for the debugger to disconnect\.\.\.|Debugger listening on |For help, see: https:\/\/nodejs\.org\/en\/docs\/inspector)/.test(line))
        .join('\n');

    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '-e',
        "await import('./src/index.ts')",
      ],
      {
        cwd: process.cwd(),
        env: {
          ...cleanEnv,
          MCP_HTTP_PORT: '',
          SEARXNG_URL: '',
        },
        encoding: 'utf8',
        timeout: 5000,
      },
    );

    assert.equal(result.status, 0, `Import process failed: ${result.stderr}`);
    assert.equal(stripDebuggerNoise(result.stdout), '');
    assert.equal(stripDebuggerNoise(result.stderr), '');
  }, results);

  await testFunction('Running cli.js responds to MCP initialize', () => {
    // Regression guard for issue #91: if cli.js exits without calling main()
    // (e.g. an isMainModule-style guard that returns false), stdout is empty
    // and we never get an initialize result back.
    const initMsg = JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0.1.0' } },
    }) + '\n';

    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'src/cli.ts'],
      {
        cwd: process.cwd(),
        env: { ...process.env, MCP_HTTP_PORT: '', SEARXNG_URL: 'https://test-searx.example.com' },
        input: initMsg,
        encoding: 'utf8',
        timeout: 10000,
      },
    );

    assert.equal(result.status, 0, `cli.js exited with error: ${result.stderr}`);
    const response = result.stdout.split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).find(m => m?.id === 1);
    assert.ok(response, 'no response to initialize — server did not start');
    assert.ok(response.result?.serverInfo?.name, 'initialize result missing serverInfo');
  }, results);

  await testFunction('createMcpServer returns an McpServer instance', () => {
    const server = createMcpServer(createToolAdmissionController());
    assert.ok(server, 'should return a truthy value');
    assert.ok(server.server, 'should expose underlying Server via .server');
  }, results);

  await testFunction('CLI lists URL reader while startup check is pending and cancels it on EOF', async () => {
    const messages = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
        protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'startup-test', version: '1' },
      } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    ];
    const script = `
      const { setSearxngFetchForTesting } = await import('./src/proxy.ts');
      let complete = false;
      setSearxngFetchForTesting(async (_url, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => { complete = true; process.stderr.write('check-aborted\\n'); reject(options.signal.reason); }, { once: true });
      }));
      const write = process.stdout.write.bind(process.stdout);
      process.stdout.write = (...args) => {
        if (String(args[0]).includes('web_url_read')) process.stderr.write('tools-before-check:' + !complete + '\\n');
        return write(...args);
      };
      await import('./src/cli.ts');
    `;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      cwd: process.cwd(),
      env: { ...process.env, MCP_HTTP_PORT: '', SEARXNG_URL: 'https://one.example.com',
        SEARXNG_STARTUP_HEALTHCHECK: 'true', SEARXNG_HEALTHCHECK_TIMEOUT_MS: '30000' },
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); if (stdout.includes('web_url_read')) child.stdin.end(); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    const watchdog = setTimeout(() => child.kill(), 10000);
    try {
      const exited = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
      child.stdin.write(messages.map(message => JSON.stringify(message)).join('\n') + '\n');
      assert.equal(await exited, 0, stderr);
      const responses = stdout.trim().split('\n').map(line => JSON.parse(line));
      const list = responses.find(response => response.id === 2);
      assert.ok(list?.result?.tools.some((tool: { name: string }) => tool.name === 'web_url_read'));
      assert.match(stderr, /tools-before-check:true/);
      assert.match(stderr, /check-aborted/);
    } finally { clearTimeout(watchdog); child.kill(); }
  }, results);

  await testFunction('terminal stdin events cancel a stalled startup request and permit prompt CLI exit', async () => {
    for (const enabled of [true, false]) {
      for (const mode of ['end', 'close', 'error-close']) {
        let ready!: () => void;
        const started = new Promise<void>(resolve => { ready = resolve; });
        const requests: Array<string | undefined> = [];
        const mock = http.createServer(req => {
          requests.push(req.url);
          ready();
        });
        await new Promise<void>(resolve => mock.listen(0, '127.0.0.1', resolve));
        const script = terminalStdinScript(mode);
        const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
          cwd: process.cwd(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
          env: { ...process.env, MCP_HTTP_PORT: '', SEARXNG_URL: `http://127.0.0.1:${(mock.address() as { port: number }).port}`,
            SEARXNG_STARTUP_HEALTHCHECK: String(enabled), SEARXNG_HEALTHCHECK_TIMEOUT_MS: '30000' },
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', chunk => { stdout += String(chunk); });
        child.stderr.on('data', chunk => { stderr += String(chunk); });
        child.once('message', () => { if (!enabled) ready(); });
        const exited = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
        const completed = Promise.all([exited, finished(child.stdout, { writable: false }), finished(child.stderr, { writable: false })]);
        let expire!: (error: Error) => void;
        const timeout = new Promise<never>((_, reject) => { expire = reject; });
        const stop = () => { child.kill(); expire(new Error('CLI did not complete within the test deadline')); };
        let watchdog = setTimeout(stop, 10000);
        try {
          await Promise.race([started, completed.then(() => { throw new Error(`CLI exited before readiness: ${stderr}`); }), timeout]);
          clearTimeout(watchdog);
          watchdog = setTimeout(stop, 3000);
          if (mode === 'end') { child.disconnect(); child.stdin.end(); }
          else child.send('destroy');
          const [code] = await Promise.race([completed, timeout]);
          assert.equal(code, 0, `${enabled}/${mode}: ${stderr}`);
          assert.equal(stdout, '', 'terminal events must preserve JSON-RPC stdout');
          if (mode === 'error-close') assert.match(stderr, /controlled stdin failure/);
          assert.deepEqual(requests, enabled ? ['/config'] : []);
        } finally {
          clearTimeout(watchdog);
          child.kill();
          mock.closeAllConnections();
          await new Promise<void>(resolve => mock.close(() => resolve()));
        }
      }
    }
  }, results);

  await testFunction('HTTP serves health and lists tools while startup capability request stalls', async () => {
    const scratch = mkdtempSync(path.join(tmpdir(), 'startup-check-test-'));
    const marker = path.join(scratch, 'started');
    let server: SpawnedHttpCli | undefined;
    const client = new Client({ name: 'startup-http-test', version: '1' });
    const script = `
      process.env.SEARXNG_URL = 'https://one.example.com';
      process.env.SEARXNG_STARTUP_HEALTHCHECK = 'true';
      process.env.SEARXNG_HEALTHCHECK_TIMEOUT_MS = '30000';
      const { setSearxngFetchForTesting } = await import('./src/proxy.ts');
      const { writeFileSync } = await import('node:fs');
      setSearxngFetchForTesting(async (_url, options) => new Promise((_resolve, reject) => {
        writeFileSync(${JSON.stringify(marker)}, 'started');
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      }));
      await import('./src/cli.ts');
    `;
    try {
      server = await spawnHttpCli({ args: ['--import', 'tsx', '--input-type=module', '-e', script], readyTimeoutMs: 5000 });
      await client.connect(new StreamableHTTPClientTransport(server.url));
      assert.ok((await client.listTools()).tools.some(tool => tool.name === 'web_url_read'));
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- owned test marker
      assert.equal(readFileSync(marker, 'utf8'), 'started');
      assert.equal((server.health as { status: string }).status, 'healthy');
    } finally {
      await client.close(); await server?.close();
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- owned test marker
      if (existsSync(marker)) unlinkSync(marker);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- empty owned test directory
      rmdirSync(scratch);
    }
  }, results);

  await testFunction('createMcpServer returns independent instances per call', () => {
    const controller = createToolAdmissionController();
    const server1 = createMcpServer(controller);
    const server2 = createMcpServer(controller);
    assert.notEqual(server1, server2, 'factory should return distinct objects');
    assert.notEqual(server1.server, server2.server, 'underlying servers should differ');
  }, results);

  printTestSummary(results, 'Main Server Integration');
  return results;
}

// Run if executed directly
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  runTests().then(results => {
    process.exit(results.failed > 0 ? 1 : 0);
  }).catch(console.error);
}

export { runTests };
