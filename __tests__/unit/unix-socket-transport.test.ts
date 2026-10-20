#!/usr/bin/env tsx

/**
 * Unit Tests: unix socket transport (proxy.ts + searxng-instances.ts + diagnostic-sanitizer.ts)
 */

import { strict as assert } from 'node:assert';
import { fileURLToPath } from 'node:url';
import {
  fetchSearxng,
  getUnixSocketAgent,
  closeUnixSocketAgents,
  setSearxngFetchForTesting,
  splitUnixSocketPath,
} from '../../src/proxy.js';
import {
  validateSearxngInstanceUrl,
  redactSearxngInstanceUrl,
} from '../../src/searxng-instances.js';
import {
  initializeDiagnosticSanitizer,
  resetDiagnosticSanitizerForTests,
  sanitizeDiagnosticText,
} from '../../src/diagnostic-sanitizer.js';
import { testFunction, createTestResults, printTestSummary } from '../helpers/test-utils.js';
import { EnvManager } from '../helpers/env-utils.js';

const results = createTestResults();
const envManager = new EnvManager();

async function runTests() {
  console.log('🧪 Testing: unix socket transport\n');

  await testFunction('validateSearxngInstanceUrl accepts unix: URLs', () => {
    assert.equal(validateSearxngInstanceUrl('unix:///run/searxng/searxng.sock'), null);
  }, results);

  await testFunction('redactSearxngInstanceUrl leaves credential-free unix URL unchanged', () => {
    assert.equal(redactSearxngInstanceUrl('unix:///run/searxng/searxng.sock'), 'unix:///run/searxng/searxng.sock');
  }, results);

  await testFunction('fetchSearxng rewrites matching unix URL preserving query and sets dispatcher', async () => {
    envManager.set('SEARXNG_URL', 'unix:///run/searxng/searxng.sock');
    closeUnixSocketAgents();

    let captured: { input: any; options: any } | undefined;
    setSearxngFetchForTesting(async (input: any, options: any) => {
      captured = { input, options };
      return { ok: true, status: 200 } as any;
    });

    try {
      const resp = await fetchSearxng('unix:///run/searxng/searxng.sock/search?q=hello&lang=en', { method: 'GET', headers: { 'X-Test': '1' } });
      assert.ok(resp);
      assert.ok(captured, 'fetch should have been called');
      assert.equal(captured!.input, 'http://unix/search?q=hello&lang=en');
      assert.ok(captured!.options?.dispatcher, 'dispatcher must be set');
      assert.equal(captured!.options.dispatcher.constructor.name, 'Agent');
      assert.equal(captured!.options.method, 'GET');
      assert.equal(captured!.options.headers?.['X-Test'], '1');
    } finally {
      setSearxngFetchForTesting();
      closeUnixSocketAgents();
      envManager.restore();
    }
  }, results);

  await testFunction('fetchSearxng maps socket-root path to /', async () => {
    envManager.set('SEARXNG_URL', 'unix:///run/searxng/searxng.sock');
    closeUnixSocketAgents();

    let capturedInput: any;
    setSearxngFetchForTesting(async (input: any) => {
      capturedInput = input;
      return { ok: true } as any;
    });

    try {
      await fetchSearxng('unix:///run/searxng/searxng.sock', {});
      assert.equal(capturedInput, 'http://unix/');
    } finally {
      setSearxngFetchForTesting();
      closeUnixSocketAgents();
      envManager.restore();
    }
  }, results);

  await testFunction('fetchSearxng falls through for non-matching unix path', async () => {
    envManager.set('SEARXNG_URL', 'unix:///run/searxng/searxng.sock');
    closeUnixSocketAgents();

    let capturedInput: any;
    let capturedOptions: any;
    setSearxngFetchForTesting(async (input: any, options: any) => {
      capturedInput = input;
      capturedOptions = options;
      return { ok: true } as any;
    });

    const opts = { method: 'GET' } as RequestInit;
    try {
      await fetchSearxng('unix:///some/other/path', opts);
      assert.equal(capturedInput, 'unix:///some/other/path');
      assert.equal(capturedOptions, opts);
    } finally {
      setSearxngFetchForTesting();
      closeUnixSocketAgents();
      envManager.restore();
    }
  }, results);

  await testFunction('fetchSearxng does not throw on malformed percent-encoding', async () => {
    envManager.set('SEARXNG_URL', 'unix:///run/sock/%ZZ');
    closeUnixSocketAgents();

    setSearxngFetchForTesting(async () => ({ ok: true }) as any);
    try {
      await fetchSearxng('unix:///run/sock/%ZZ/path', {});
      assert.ok(true);
    } finally {
      setSearxngFetchForTesting();
      closeUnixSocketAgents();
      envManager.restore();
    }
  }, results);

  await testFunction('fetchSearxng passes HTTP/HTTPS requests through unchanged', async () => {
    let capturedInput: any;
    let capturedOptions: any;
    setSearxngFetchForTesting(async (input: any, options: any) => {
      capturedInput = input;
      capturedOptions = options;
      return { ok: true } as any;
    });

    const opts = { method: 'POST', headers: { 'X': 'y' } } as RequestInit;
    try {
      const url = 'https://searx.example.com/search';
      await fetchSearxng(url, opts);
      assert.equal(capturedInput, url);
      assert.equal(capturedOptions, opts);
    } finally {
      setSearxngFetchForTesting();
    }
  }, results);

  await testFunction('getUnixSocketAgent reuses agent per socket path', () => {
    closeUnixSocketAgents();
    envManager.set('SEARXNG_URL', 'unix:///a.sock;unix:///b.sock');
    try {
      const a1 = getUnixSocketAgent('/a.sock');
      const a2 = getUnixSocketAgent('/a.sock');
      const b1 = getUnixSocketAgent('/b.sock');
      assert.equal(a1, a2, 'same path reuses agent');
      assert.notEqual(a1, b1, 'different paths get distinct agents');
    } finally {
      closeUnixSocketAgents();
      envManager.restore();
    }
  }, results);

  await testFunction('selecting another socket does not close the first agent', () => {
    closeUnixSocketAgents();
    envManager.set('SEARXNG_URL', 'unix:///a.sock;unix:///b.sock');
    try {
      const a = getUnixSocketAgent('/a.sock');
      const b = getUnixSocketAgent('/b.sock');
      // neither close should have been called; agents still usable objects
      assert.ok(a);
      assert.ok(b);
      assert.notEqual(a, b);
      // reuse still works after selecting b
      assert.equal(getUnixSocketAgent('/a.sock'), a);
    } finally {
      closeUnixSocketAgents();
      envManager.restore();
    }
  }, results);

  await testFunction('closeUnixSocketAgents clears cache', () => {
    closeUnixSocketAgents();
    envManager.set('SEARXNG_URL', 'unix:///a.sock');
    try {
      const a = getUnixSocketAgent('/a.sock');
      closeUnixSocketAgents();
      const a2 = getUnixSocketAgent('/a.sock');
      assert.notEqual(a, a2, 'new agent after close');
    } finally {
      closeUnixSocketAgents();
      envManager.restore();
    }
  }, results);

  await testFunction('splitUnixSocketPath returns null for non-configured path', () => {
    envManager.set('SEARXNG_URL', 'unix:///run/searxng/searxng.sock');
    try {
      assert.equal(splitUnixSocketPath('/totally/unrelated'), null);
    } finally {
      envManager.restore();
    }
  }, results);

  await testFunction('sanitizer passes credential-free unix URL', () => {
    resetDiagnosticSanitizerForTests();
    initializeDiagnosticSanitizer({ SEARXNG_URL: 'unix:///run/searxng/searxng.sock' });
    try {
      const out = sanitizeDiagnosticText('endpoint unix:///run/searxng/searxng.sock ok');
      assert.equal(out, 'endpoint unix:///run/searxng/searxng.sock ok');
      assert.ok(!out.includes('[redacted diagnostic]'));
    } finally {
      resetDiagnosticSanitizerForTests();
    }
  }, results);

  await testFunction('sanitizer protects credentials in AUTH_* with unix instance', () => {
    resetDiagnosticSanitizerForTests();
    initializeDiagnosticSanitizer({ SEARXNG_URL: 'unix:///run/searxng/searxng.sock', AUTH_USERNAME: 'u', AUTH_PASSWORD: 'p' });
    try {
      const out = sanitizeDiagnosticText('user u pass p Basic ' + Buffer.from('u:p').toString('base64'));
      assert.ok(!out.includes('u:p') || out.includes('[redacted]'), out);
      assert.ok(out.includes('[redacted]'), out);
    } finally {
      resetDiagnosticSanitizerForTests();
    }
  }, results);

  printTestSummary(results, 'Unix Socket Transport');
  return results;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  runTests().then(results => {
    process.exit(results.failed > 0 ? 1 : 0);
  }).catch(console.error);
}

export { runTests };