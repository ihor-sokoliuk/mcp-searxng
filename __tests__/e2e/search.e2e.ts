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

async function runTests() {
  console.log('🌐 E2E Testing: searxng_web_search (live)\n');

  const localSkip = checkSkipConditions(false);
  if (localSkip) {
    console.log(localSkip);
    return { passed: 0, failed: 0, errors: [] };
  }

  await testFunction('built CLI exposes the environment-aware response_format schema', async () => {
    const responses = spawnWithMessages([
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
  }, results);

  const skip = checkSkipConditions();
  if (skip) {
    console.log(skip);
    printTestSummary(results, 'E2E: Web Search');
    return results;
  }

  await testFunction('basic search returns results with title and URL', async () => {
    const responses = spawnWithMessages([
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
    const responses = spawnWithMessages([
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
    const responses = spawnWithMessages([
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
    const responses = spawnWithMessages([
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

  await testFunction('configured JSON default applies when omitted and explicit text still wins', async () => {
    process.env.SEARXNG_DEFAULT_RESPONSE_FORMAT = 'json';
    const responses = spawnWithMessages([
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
