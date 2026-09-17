import { strict as assert } from 'node:assert';
import { fileURLToPath } from 'node:url';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createMcpServer, createToolAdmissionController } from '../../src/index.js';
import { setSearxngFetchForTesting } from '../../src/proxy.js';
import { clearInstanceInfoCacheForTests } from '../../src/instance-info.js';
import { initializeDiagnosticSanitizer, resetDiagnosticSanitizerForTests, sanitizeDiagnosticText, sanitizeDiagnosticValue } from '../../src/diagnostic-sanitizer.js';
import { createConfigResource } from '../../src/resources.js';
import { assertSafeOutput, WITHHELD_CONTENT_MESSAGE } from '../../src/credential-output.js';
import { snapshotProcessEnv, restoreProcessEnv } from '../helpers/env-utils.js';
import { createTestResults, testFunction, printTestSummary } from '../helpers/test-utils.js';

export async function runTests() {
  const results = createTestResults();
  await testFunction('output guard preserves large valid content and withholds covered representations and keys', () => {
    resetDiagnosticSanitizerForTests();
    initializeDiagnosticSanitizer({ AUTH_USERNAME:'guard-user', AUTH_PASSWORD:'guard@/marker' });
    try {
      const safe = JSON.stringify({results:Array.from({length:150}, () => ({content:'ordinary content'.repeat(100)}))});
      assert.ok(safe.length > 64 * 1024);
      assert.doesNotThrow(() => assertSafeOutput(safe));
      assert.doesNotThrow(() => assertSafeOutput('literal \\Uffff path'));
      const escaped = String.raw`guard\u0040\/marker`;
      const forms = ['guard@/marker','guard%40%2fmarker','guard%2540%252fmarker',escaped, encodeURIComponent(encodeURIComponent(escaped)), Buffer.from('guard-user:guard@/marker').toString('base64')];
      for (const form of forms) {
        assert.throws(() => assertSafeOutput(form), { message:WITHHELD_CONTENT_MESSAGE });
        assert.throws(() => assertSafeOutput(JSON.stringify({[form]:'value'})), { message:WITHHELD_CONTENT_MESSAGE });
      }
    } finally { resetDiagnosticSanitizerForTests(); }
    initializeDiagnosticSanitizer({ AUTH_PASSWORD:'x' });
    try { assert.throws(() => assertSafeOutput('text'), {message:WITHHELD_CONTENT_MESSAGE}); }
    finally { resetDiagnosticSanitizerForTests(); }
    initializeDiagnosticSanitizer({ AUTH_PASSWORD:'nMarker' });
    try { assert.throws(() => assertSafeOutput('\\nMarker'), {message:WITHHELD_CONTENT_MESSAGE}); }
    finally { resetDiagnosticSanitizerForTests(); }
  }, results);
  await testFunction('malformed instance settings and URL query credentials are concealed', () => {
    const saved = snapshotProcessEnv();
    try {
      for (const setting of ['audituser:audit-marker@search.example.test', 'https://search.example.test/path?key=audit-marker#private']) {
        process.env.SEARXNG_URL = setting;
        resetDiagnosticSanitizerForTests();
        initializeDiagnosticSanitizer();
        assert.ok(!sanitizeDiagnosticText(setting).includes('audit-marker'));
        assert.ok(!createConfigResource().includes('audit-marker'));
      }
    } finally { restoreProcessEnv(saved); resetDiagnosticSanitizerForTests(); }
  }, results);
  await testFunction('serialized credentials, username-only tokens and diagnostic keys are concealed', () => {
    const password = 'audit"quoted\\marker';
    resetDiagnosticSanitizerForTests();
    initializeDiagnosticSanitizer({ AUTH_PASSWORD: password, SEARXNG_URL: 'https://audit-token@search.example.test' });
    try {
      const escaped = JSON.stringify(password).slice(1, -1);
      assert.ok(!sanitizeDiagnosticText(escaped).includes(escaped));
      assert.ok(!sanitizeDiagnosticText('rejected audit-token').includes('audit-token'));
      assert.ok(!JSON.stringify(sanitizeDiagnosticValue({ [password]: 'data' })).includes(escaped));
    } finally { resetDiagnosticSanitizerForTests(); }
  }, results);
  for (const modern of [false, true]) {
    await testFunction(`tool outputs protect credentials before truncation (${modern ? 'modern' : 'legacy'})`, async () => {
      const saved = snapshotProcessEnv();
      const password = ['fixture','confidential','marker'].join('-');
      const header = `Basic ${Buffer.from(`fixture-user:${password}`).toString('base64')}`;
      const server = createMcpServer(createToolAdmissionController(), modern);
      const client = new Client({name:'output-test',version:'1'}, {capabilities:{}});
      try {
        for (const key of Object.keys(process.env)) if (/proxy|^AUTH_|^SEARXNG_|^MCP_HTTP_/i.test(key)) delete process.env[key];
        process.env.SEARXNG_URL = `https://fixture-user:${password}@search.example.test/`;
        process.env.SEARXNG_MAX_RESULT_CHARS = '8';
        resetDiagnosticSanitizerForTests();
        initializeDiagnosticSanitizer();
        const [ct, st] = InMemoryTransport.createLinkedPair();
        await server.connect(st); await client.connect(ct);
        setSearxngFetchForTesting(async (input, options) => {
          assert.equal(new Headers(options?.headers).get('authorization'), header);
          const path = new URL(String(input)).pathname;
          if (path === '/config') return new Response('', {status:401,statusText:`Denied ${header}`});
          if (path === '/autocompleter') return Response.json(['query',[header]]);
          return Response.json({results:[{title:'Fixture',url:'https://example.test/',content:password}]});
        });
        for (const response_format of ['json','text']) for (const result_detail of ['full','compact']) {
          const result = await client.callTool({name:'searxng_web_search',arguments:{query:`output-${modern}-${response_format}-${result_detail}`,response_format,result_detail}});
          assert.equal(result.isError, true, JSON.stringify(result));
          assert.ok(!JSON.stringify(result).includes(password.slice(0,8)));
        }
        const suggestions = await client.callTool({name:'searxng_search_suggestions',arguments:{query:'output'}});
        assert.equal(suggestions.isError, true);
        clearInstanceInfoCacheForTests();
        const info = await client.callTool({name:'searxng_instance_info',arguments:{refresh:true}});
        assert.ok(!JSON.stringify(info).includes(header));
      } finally {
        await client.close(); await server.close(); setSearxngFetchForTesting();
        clearInstanceInfoCacheForTests(); restoreProcessEnv(saved); resetDiagnosticSanitizerForTests();
      }
    }, results);
  }
  printTestSummary(results, 'Credential output');
  return results;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runTests().then(r => { process.exitCode = r.failed ? 1 : 0; }).catch(error => { console.error(error); process.exitCode = 1; });
}
