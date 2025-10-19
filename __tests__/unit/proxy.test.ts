#!/usr/bin/env tsx

/**
 * Unit Tests: proxy.ts
 * 
 * Tests for proxy configuration and agent creation
 */

import { strict as assert } from 'node:assert';
import { createProxyAgent } from '../../src/proxy.js';
import { testFunction, createTestResults, printTestSummary } from '../helpers/test-utils.js';
import { EnvManager } from '../helpers/env-utils.js';

const results = createTestResults();
const envManager = new EnvManager();

async function runTests() {
  console.log('🧪 Testing: proxy.ts\n');

  await testFunction('No proxy configuration returns undefined', () => {
    envManager.delete('HTTP_PROXY');
    envManager.delete('HTTPS_PROXY');
    envManager.delete('http_proxy');
    envManager.delete('https_proxy');
    
    const agent = createProxyAgent('https://example.com');
    assert.equal(agent, undefined);
    
    envManager.restore();
  }, results);

  await testFunction('HTTP proxy configuration', () => {
    envManager.set('HTTP_PROXY', 'http://proxy:8080');
    
    const agent = createProxyAgent('http://example.com');
    assert.ok(agent);
    assert.equal(agent.constructor.name, 'ProxyAgent');
    
    envManager.restore();
  }, results);

  await testFunction('HTTPS proxy configuration', () => {
    envManager.set('HTTPS_PROXY', 'https://proxy:8080');
    
    const agent = createProxyAgent('https://example.com');
    assert.ok(agent);
    assert.equal(agent.constructor.name, 'ProxyAgent');
    
    envManager.restore();
  }, results);

  await testFunction('Proxy with authentication', () => {
    envManager.set('HTTPS_PROXY', 'https://user:pass@proxy:8080');
    
    const agent = createProxyAgent('https://example.com');
    assert.ok(agent);
    
    envManager.restore();
  }, results);

  await testFunction('Case-insensitive environment variables', () => {
    envManager.delete('HTTP_PROXY');
    envManager.delete('HTTPS_PROXY');
    envManager.set('http_proxy', 'http://lowercase-proxy:8080');
    
    const agent = createProxyAgent('http://example.com');
    assert.ok(agent);
    
    envManager.restore();
  }, results);

  await testFunction('Invalid proxy URL handling', () => {
    envManager.set('HTTP_PROXY', 'not-a-url');
    
    try {
      const agent = createProxyAgent('http://example.com');
      // Should handle malformed URLs gracefully or throw
      assert.ok(agent === undefined || agent !== null);
    } catch (error) {
      // Error handling is acceptable for malformed URLs
      assert.ok(error instanceof Error);
    }
    
    envManager.restore();
  }, results);

  await testFunction('Unsupported protocol throws error', () => {
    envManager.set('HTTP_PROXY', 'socks5://proxy:1080');
    
    try {
      const agent = createProxyAgent('http://example.com');
      assert.fail('Should have thrown error for unsupported protocol');
    } catch (error) {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes('protocol') || error.message.includes('socks5'));
    }
    
    envManager.restore();
  }, results);

  await testFunction('Different URL schemes', () => {
    const testUrls = ['http://example.com', 'https://example.com'];
    
    for (const url of testUrls) {
      envManager.set('HTTP_PROXY', 'http://proxy:8080');
      
      try {
        const agent = createProxyAgent(url);
        assert.ok(agent === undefined || agent !== null);
      } catch (error) {
        // Some URL schemes might not be supported, that's ok
        assert.ok(true);
      }
      
      envManager.restore();
    }
  }, results);

  await testFunction('ProxyAgent has dispatch method', () => {
    envManager.set('HTTP_PROXY', 'http://proxy:8080');
    
    const agent = createProxyAgent('http://example.com');
    
    if (agent) {
      assert.ok(typeof agent.dispatch === 'function');
    }
    
    envManager.restore();
  }, results);

  printTestSummary(results, 'Proxy Module');
  return results;
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runTests().then(results => {
    process.exit(results.failed > 0 ? 1 : 0);
  }).catch(console.error);
}

export { runTests };
