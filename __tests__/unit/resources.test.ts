#!/usr/bin/env tsx

/**
 * Unit Tests: resources.ts
 * 
 * Tests for resource generation
 */

import { strict as assert } from 'node:assert';
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

    const config = JSON.parse(createConfigResource());
    assert.equal(config.environment.hasAuth, false);

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

  printTestSummary(results, 'Resources Module');
  return results;
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runTests().then(results => {
    process.exit(results.failed > 0 ? 1 : 0);
  }).catch(console.error);
}

export { runTests };
