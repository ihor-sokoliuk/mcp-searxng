#!/usr/bin/env tsx

/**
 * Unit Tests: resources.ts
 * 
 * Tests for resource generation
 */

import { strict as assert } from 'node:assert';
import { fileURLToPath } from 'node:url';
import { createConfigResource, createHelpResource } from '../../src/resources.js';
import { testFunction, createTestResults, printTestSummary } from '../helpers/test-utils.js';
import { EnvManager } from '../helpers/env-utils.js';

const results = createTestResults();
const envManager = new EnvManager();

async function runTests() {
  console.log('🧪 Testing: resources.ts\n');

  await testFunction('createConfigResource returns valid JSON string', () => {
    const config = createConfigResource();
    
    assert.ok(typeof config === 'string');
    assert.ok(config.length > 0);
    
    // Should be valid JSON
    const parsed = JSON.parse(config);
    assert.ok(typeof parsed === 'object');
  }, results);

  await testFunction('createConfigResource includes environment variables', () => {
    const config = createConfigResource();
    const parsed = JSON.parse(config);
    
    // Check that config includes environment information
    assert.ok(parsed.environment);
    assert.ok(parsed.environment.searxngUrl || parsed.environment.hasOwnProperty('searxngUrl'));
    assert.ok(parsed.environment.currentLogLevel || parsed.environment.hasOwnProperty('currentLogLevel'));
  }, results);

  await testFunction('createHelpResource returns markdown string', () => {
    const help = createHelpResource();
    
    assert.ok(typeof help === 'string');
    assert.ok(help.length > 0);
  }, results);

  await testFunction('createHelpResource includes usage information', () => {
    const help = createHelpResource();
    
    // Should include information about tools
    assert.ok(help.includes('searxng') || help.includes('search') || help.includes('SearXNG'));
  }, results);

  await testFunction('config resource advertises all registered tools', () => {
    const config = JSON.parse(createConfigResource());

    assert.deepEqual(config.capabilities.tools, [
      'searxng_web_search',
      'searxng_search_suggestions',
      'searxng_instance_info',
      'web_url_read',
    ]);
  }, results);

  await testFunction('help resource documents all tools and current search parameters', () => {
    const help = createHelpResource();

    assert.ok(help.includes('### 1. searxng_web_search'), 'missing search tool section');
    assert.ok(help.includes('`num_results`'), 'missing num_results parameter');
    assert.ok(help.includes('`categories`'), 'missing categories parameter');
    assert.ok(help.includes('`response_format`'), 'missing response_format parameter');
    assert.ok(help.includes('metadata sections'), 'missing metadata/direct-answer output note');
    assert.ok(help.includes('### 2. searxng_search_suggestions'), 'missing suggestions tool section');
    assert.ok(help.includes('### 3. searxng_instance_info'), 'missing instance info tool section');
    assert.ok(help.includes('### 4. web_url_read'), 'missing URL reader tool section');
  }, results);

  await testFunction('help resource recommends URL userinfo for SearXNG Basic Auth', () => {
    const help = createHelpResource();

    assert.ok(help.includes('https://user:password@search.example.com'), 'missing URL userinfo auth example');
    assert.ok(help.includes('percent-encode'), 'missing percent-encoding note');
    assert.ok(help.includes('Legacy global Basic Auth fallback'), 'missing legacy AUTH_* fallback note');
  }, results);

  await testFunction('createConfigResource - hasAuth true when both credentials set', () => {
    envManager.set('AUTH_USERNAME', 'testuser');
    envManager.set('AUTH_PASSWORD', 'testpass');

    const config = JSON.parse(createConfigResource());
    assert.equal(config.environment.hasAuth, true);

    envManager.restore();
  }, results);

  await testFunction('createConfigResource - hasAuth false when credentials absent', () => {
    envManager.delete('AUTH_USERNAME');
    envManager.delete('AUTH_PASSWORD');
    envManager.set('SEARXNG_URL', 'https://search.example.com');

    const config = JSON.parse(createConfigResource());
    assert.equal(config.environment.hasAuth, false);

    envManager.restore();
  }, results);

  await testFunction('createConfigResource - hasAuth true when SEARXNG_URL carries userinfo without global AUTH_*', () => {
    envManager.delete('AUTH_USERNAME');
    envManager.delete('AUTH_PASSWORD');
    envManager.set('SEARXNG_URL', 'https://token@search.example.com');

    const config = JSON.parse(createConfigResource());
    assert.equal(config.environment.hasAuth, true);

    envManager.restore();
  }, results);

  await testFunction('createConfigResource - redacts embedded userinfo from searxngUrl (non-hardened)', () => {
    envManager.delete('MCP_HTTP_HARDEN');
    envManager.set('SEARXNG_URL', 'https://user:p%40ss@search.example.com;https://public.example.com');

    const config = JSON.parse(createConfigResource());
    assert.ok(config.environment.searxngUrl, 'expected searxngUrl to be exposed in non-hardened mode');
    // Parse each entry and assert on the exact host so a leaked credential can't
    // hide in a substring, and no userinfo survives redaction.
    const entries = config.environment.searxngUrl.split('; ').map((entry: string) => new URL(entry));
    assert.equal(entries.length, 2);
    assert.equal(entries[0].hostname, 'search.example.com');
    assert.equal(entries[0].username, '');
    assert.equal(entries[0].password, '');
    assert.equal(entries[1].hostname, 'public.example.com');
    assert.ok(!config.environment.searxngUrl.includes('p%40ss'), config.environment.searxngUrl);

    envManager.restore();
  }, results);

  await testFunction('createConfigResource - hasProxy true when HTTP_PROXY set', () => {
    envManager.set('HTTP_PROXY', 'http://proxy:8080');

    const config = JSON.parse(createConfigResource());
    assert.equal(config.environment.hasProxy, true);

    envManager.restore();
  }, results);

  await testFunction('createConfigResource - hasProxy false when no proxy set', () => {
    envManager.delete('HTTP_PROXY');
    envManager.delete('HTTPS_PROXY');
    envManager.delete('http_proxy');
    envManager.delete('https_proxy');

    const config = JSON.parse(createConfigResource());
    assert.equal(config.environment.hasProxy, false);

    envManager.restore();
  }, results);

  await testFunction('createConfigResource - hasNoProxy true when NO_PROXY set', () => {
    envManager.set('NO_PROXY', 'localhost,127.0.0.1');

    const config = JSON.parse(createConfigResource());
    assert.equal(config.environment.hasNoProxy, true);

    envManager.restore();
  }, results);

  await testFunction('createConfigResource - transport includes http when MCP_HTTP_PORT set', () => {
    envManager.set('MCP_HTTP_PORT', '3000');

    const config = JSON.parse(createConfigResource());
    assert.ok(config.capabilities.transports.includes('http'), 'Expected "http" in transports');
    assert.ok(config.capabilities.transports.includes('stdio'), 'Expected "stdio" in transports');

    envManager.restore();
  }, results);

  await testFunction('createConfigResource - transport is stdio only when MCP_HTTP_PORT not set', () => {
    envManager.delete('MCP_HTTP_PORT');

    const config = JSON.parse(createConfigResource());
    assert.deepEqual(config.capabilities.transports, ['stdio']);

    envManager.restore();
  }, results);

  await testFunction('config resource redacts searxngUrl in hardened mode', () => {
    envManager.set('MCP_HTTP_HARDEN', 'true');
    envManager.set('MCP_HTTP_AUTH_TOKEN', 'secret-token');
    envManager.set('MCP_HTTP_ALLOWED_ORIGINS', 'https://app.example.com');
    envManager.set('SEARXNG_URL', 'https://search.internal.example');
    envManager.delete('MCP_HTTP_EXPOSE_FULL_CONFIG');

    const config = JSON.parse(createConfigResource());
    assert.equal(config.environment.searxngUrlConfigured, true);
    assert.equal(config.environment.searxngUrl, undefined);

    envManager.restore();
  }, results);

  await testFunction('debug override exposes full config in hardened mode', () => {
    envManager.set('MCP_HTTP_HARDEN', 'true');
    envManager.set('MCP_HTTP_AUTH_TOKEN', 'secret-token');
    envManager.set('MCP_HTTP_ALLOWED_ORIGINS', 'https://app.example.com');
    envManager.set('MCP_HTTP_EXPOSE_FULL_CONFIG', 'true');
    envManager.set('SEARXNG_URL', 'https://search.internal.example');

    const config = JSON.parse(createConfigResource());
    assert.equal(config.environment.searxngUrl, 'https://search.internal.example');

    envManager.restore();
  }, results);

  printTestSummary(results, 'Resources Module');
  return results;
}

// Run if executed directly
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  runTests().then(results => {
    process.exit(results.failed > 0 ? 1 : 0);
  }).catch(console.error);
}

export { runTests };
