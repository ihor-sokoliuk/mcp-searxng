#!/usr/bin/env tsx

/**
 * E2E Tests: searxng_web_search tool against live SearXNG instance.
 *
 * Requires: SEARXNG_LIVE_URL env var + built dist/cli.js
 * Run: npm run test:e2e
 *
 * What mocks can't prove: real SearXNG connectivity, actual response format,
 * result scoring, and optional parameter handling end-to-end.
 */

import { strict as assert } from 'node:assert';
import { fileURLToPath } from 'node:url';
import {
  checkSkipConditions,
  INIT_PARAMS,
  spawnWithMessages,
} from './helpers/spawn-server.js';
import { testFunction, createTestResults, printTestSummary } from '../helpers/test-utils.js';

const results = createTestResults();

function getToolResponseText(response: any): string {
  assert.ok(response && !response.error, `server error: ${JSON.stringify(response?.error)}`);
  return response.result?.content?.[0]?.text ?? '';
}

function assertCompactText(text: string): void {
  assert.ok(text.length > 0, 'compact text should be non-empty');
  assert.ok(!text.endsWith('\n'), text);
  for (const marker of ['Direct answer:', 'Suggestions:', 'Corrections:', 'Infobox:', 'Relevance Score:', '_Cached result_']) assert.ok(!text.includes(marker), text);
  const records = text.split('\n\n');
  if (records.at(-1)?.startsWith('⚠️ Some search engines were unavailable: ')) {
    const warning = records.pop()!;
    assert.match(warning, /^⚠️ Some search engines were unavailable: [^\r\n]+\. Results may be incomplete\.$/u);
  }
  assert.ok(records.length > 0, 'an engine warning cannot replace the search output');
  if (records.length === 1 && records[0].startsWith('🔍 No results found for ')) return;
  for (const record of records) assert.equal(record.split('\n').length, 3, record);
}

function assertCompactJson(compact: Record<string, unknown>): void {
  assert.deepEqual(Object.keys(compact).sort(), Object.hasOwn(compact, 'unresponsive_engines') ? ['results', 'unresponsive_engines'] : ['results']);
  assert.ok(Array.isArray(compact.results));
  for (const result of compact.results) assert.deepEqual(Object.keys(result), ['title', 'url', 'content']);
  if (Object.hasOwn(compact, 'unresponsive_engines')) {
    assert.ok(Array.isArray(compact.unresponsive_engines));
    assert.ok(compact.unresponsive_engines.length > 0);
    for (const failure of compact.unresponsive_engines) {
      assert.ok(Array.isArray(failure) && failure.length === 2);
      assert.ok(failure.every(value => typeof value === 'string'));
      assert.ok(failure[0].length > 0);
    }
  }
}

async function runTests() {
  console.log('🌐 E2E Testing: searxng_web_search (live)\n');

  await testFunction('compact assertions accept only documented optional engine diagnostics', async () => {
    const text = 'Title: Test\nURL: https://example.com\nDescription: Result';
    const warning = '⚠️ Some search engines were unavailable: duckduckgo (CAPTCHA). Results may be incomplete.';
    assertCompactText(text);
    assertCompactText(`${text}\n\n${warning}`);
    const empty = '🔍 No results found for "test". Try different keywords or check your search parameters.';
    assertCompactText(empty);
    assertCompactText(`${empty}\n\n${warning}`);
    assert.throws(() => assertCompactText(warning));
    assert.throws(() => assertCompactText(`${text}\nextra\n\n${warning}`));
    assert.throws(() => assertCompactText(`${text}\n\n${warning}\nextra`));
    assert.throws(() => assertCompactText(`${text}\n\n${warning}\n\n${warning}`));
    const compact = { results: [{ title: 'Test', url: 'https://example.com', content: 'Result' }] };
    assertCompactJson(compact);
    assertCompactJson({ ...compact, unresponsive_engines: [['duckduckgo', 'CAPTCHA']] });
    assertCompactJson({ ...compact, unresponsive_engines: [['duckduckgo', '']] });
    assert.throws(() => assertCompactJson({ ...compact, warnings: ['extra'] }));
    assert.throws(() => assertCompactJson({ ...compact, unresponsive_engines: [['duckduckgo']] }));
    assert.throws(() => assertCompactJson({ ...compact, unresponsive_engines: [[12, 'CAPTCHA']] }));
    assert.throws(() => assertCompactJson({ ...compact, unresponsive_engines: [['', 'CAPTCHA']] }));
    assert.throws(() => assertCompactJson({ results: [{ ...compact.results[0], score: 1 }] }));
  }, results);

  const localSkip = checkSkipConditions(false);
  if (localSkip) {
    console.log(localSkip);
    return results;
  }

  await testFunction('built CLI exposes response_format and result_detail schemas', async () => {
    const responses = await spawnWithMessages([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: INIT_PARAMS },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    ], 'https://unused.invalid');

    const r = responses[2];
    assert.ok(r && !r.error, `server error: ${JSON.stringify(r?.error)}`);
    const searchTool = r.result?.tools?.find((tool: any) => tool.name === 'searxng_web_search');
    assert.ok(searchTool, 'tools/list should include searxng_web_search');
    const responseFormat = searchTool.inputSchema?.properties?.response_format;
    assert.deepEqual(responseFormat?.enum, ['text', 'json']);
    assert.equal('default' in responseFormat, false);
    assert.ok(responseFormat.description.includes('SEARXNG_DEFAULT_RESPONSE_FORMAT'));
    assert.ok(responseFormat.description.includes('explicit response_format always takes precedence'));
    const resultDetail = searchTool.inputSchema?.properties?.result_detail;
    assert.deepEqual(resultDetail?.enum, ['compact', 'full']);
    assert.equal('default' in resultDetail, false);
  }, results);

  const skip = checkSkipConditions();
  if (skip) {
    console.log(skip);
    printTestSummary(results, 'E2E: Web Search');
    return results;
  }

  await testFunction('basic search returns results with title and URL', async () => {
    const responses = await spawnWithMessages([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: INIT_PARAMS },
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'searxng_web_search',
          arguments: { query: 'test' },
        },
      },
    ]);

    const r = responses[2];
    assert.ok(r, 'no response to tools/call id=2');
    assert.ok(!r.error, `server returned error: ${JSON.stringify(r.error)}`);

    const text: string = r.result?.content?.[0]?.text ?? '';
    assert.ok(text.length > 0, 'response text should be non-empty');
    // The formatted output always includes a URL line
    assert.ok(text.includes('URL:'), 'response should contain URL: field');
    assert.ok(text.includes('Title:'), 'response should contain Title: field');
    assert.ok(
      !text.includes('undefined'),
      'response should not contain undefined metadata placeholders'
    );
  }, results);

  await testFunction('search with time_range=day returns results', async () => {
    const responses = await spawnWithMessages([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: INIT_PARAMS },
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'searxng_web_search',
          arguments: { query: 'test', time_range: 'day' },
        },
      },
    ]);

    const r = responses[2];
    assert.ok(r && !r.error, `server error: ${JSON.stringify(r?.error)}`);
    const text: string = r.result?.content?.[0]?.text ?? '';
    assert.ok(text.length > 0, 'time-filtered search returned empty response');
  }, results);

  await testFunction('search with language=en returns results', async () => {
    const responses = await spawnWithMessages([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: INIT_PARAMS },
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'searxng_web_search',
          arguments: { query: 'test', language: 'en' },
        },
      },
    ]);

    const r = responses[2];
    assert.ok(r && !r.error, `server error: ${JSON.stringify(r?.error)}`);
    const text: string = r.result?.content?.[0]?.text ?? '';
    assert.ok(text.length > 0, 'language-filtered search returned empty response');
  }, results);

  await testFunction('search with response_format=json returns parseable JSON', async () => {
    const responses = await spawnWithMessages([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: INIT_PARAMS },
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'searxng_web_search',
          arguments: { query: 'test', response_format: 'json', num_results: 2 },
        },
      },
    ]);

    const r = responses[2];
    assert.ok(r && !r.error, `server error: ${JSON.stringify(r?.error)}`);
    const text: string = r.result?.content?.[0]?.text ?? '';
    const payload = JSON.parse(text);
    assert.ok(Array.isArray(payload.results), 'JSON response should contain results array');
    assert.ok(payload.results.length <= 2, 'num_results should slice JSON results');
  }, results);

  await testFunction('compact text has three-line results and optional engine diagnostics without full metadata', async () => {
    const responses = await spawnWithMessages([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: INIT_PARAMS },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'searxng_web_search', arguments: { query: 'test', result_detail: 'compact', num_results: 2 } } },
    ]);
    const text = getToolResponseText(responses[2]);
    assertCompactText(text);
  }, results);

  await testFunction('compact JSON excludes full metadata and omitted detail remains valid full output', async () => {
    const responses = await spawnWithMessages([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: INIT_PARAMS },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'searxng_web_search', arguments: { query: 'test', response_format: 'json', result_detail: 'compact', num_results: 2 } } },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'searxng_web_search', arguments: { query: 'test', num_results: 1 } } },
    ]);
    const compactText = getToolResponseText(responses[2]);
    const compact = JSON.parse(compactText);
    assertCompactJson(compact);
    const fullText = getToolResponseText(responses[3]);
    assert.ok(fullText.length > 0, 'omitted result_detail should produce a valid full response');
    assert.throws(() => JSON.parse(fullText));
  }, results);

  await testFunction('configured JSON default applies when omitted and explicit text still wins', async () => {
    process.env.SEARXNG_DEFAULT_RESPONSE_FORMAT = 'json';
    const responses = await spawnWithMessages([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: INIT_PARAMS },
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'searxng_web_search',
          arguments: { query: 'test', num_results: 2 },
        },
      },
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'searxng_web_search',
          arguments: { query: 'test', num_results: 2, response_format: 'text' },
        },
      },
    ]);

    const payload = JSON.parse(getToolResponseText(responses[2]));
    assert.ok(Array.isArray(payload.results), 'configured JSON default should return a results array');

    const text = getToolResponseText(responses[3]);
    assert.ok(text.includes('Title:'), 'explicit text should return formatted results');
    assert.throws(() => JSON.parse(text));
  }, results);

  printTestSummary(results, 'E2E: Web Search');
  return results;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  runTests().then((r) => process.exit(r.failed > 0 ? 1 : 0)).catch(console.error);
}

export { runTests };
