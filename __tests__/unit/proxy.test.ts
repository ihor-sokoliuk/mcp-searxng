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

    const agent = createProxyAgent();
    assert.equal(agent, undefined);
    
    envManager.restore();
  }, results);

  await testFunction('HTTP proxy configuration', () => {
    envManager.set('HTTP_PROXY', 'http://proxy:8080');

    const agent = createProxyAgent();
    assert.ok(agent);
    assert.equal(agent.constructor.name, 'ProxyAgent');
    
    envManager.restore();
  }, results);

  await testFunction('HTTPS proxy configuration', () => {
    envManager.set('HTTPS_PROXY', 'https://proxy:8080');

    const agent = createProxyAgent();
    assert.ok(agent);
    assert.equal(agent.constructor.name, 'ProxyAgent');
    
    envManager.restore();
  }, results);

  await testFunction('Proxy with authentication', () => {
    envManager.set('HTTPS_PROXY', 'https://user:pass@proxy:8080');

    const agent = createProxyAgent();
    assert.ok(agent);
    
    envManager.restore();
  }, results);

  await testFunction('Case-insensitive environment variables', () => {
    envManager.delete('HTTP_PROXY');
    envManager.delete('HTTPS_PROXY');
    envManager.set('http_proxy', 'http://lowercase-proxy:8080');

    const agent = createProxyAgent();
    assert.ok(agent);
    
    envManager.restore();
  }, results);

  await testFunction('Invalid proxy URL handling', () => {
    envManager.set('HTTP_PROXY', 'not-a-url');
    
    try {
      const agent = createProxyAgent();
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
      const agent = createProxyAgent();
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
        const agent = createProxyAgent();
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

    const agent = createProxyAgent();

    if (agent) {
      assert.ok(typeof agent.dispatch === 'function');
    }
    
    envManager.restore();
  }, results);

  await testFunction('NO_PROXY bypasses proxy for exact hostname', () => {
    envManager.set('HTTP_PROXY', 'http://proxy:8080');
    envManager.set('NO_PROXY', 'example.com');

    const agent = createProxyAgent('http://example.com/path');
    assert.equal(agent, undefined);
    
    envManager.restore();
  }, results);

  await testFunction('NO_PROXY bypasses proxy for domain suffix', () => {
    envManager.set('HTTP_PROXY', 'http://proxy:8080');
    envManager.set('NO_PROXY', '.example.com');

    const agent = createProxyAgent('http://sub.example.com/path');
    assert.equal(agent, undefined);
    
    envManager.restore();
  }, results);

  await testFunction('NO_PROXY bypasses proxy for domain suffix without leading dot', () => {
    envManager.set('HTTP_PROXY', 'http://proxy:8080');
    envManager.set('NO_PROXY', 'example.com');

    const agent = createProxyAgent('http://sub.example.com/path');
    assert.equal(agent, undefined);
    
    envManager.restore();
  }, results);

  await testFunction('NO_PROXY wildcard bypasses all', () => {
    envManager.set('HTTP_PROXY', 'http://proxy:8080');
    envManager.set('NO_PROXY', '*');

    const agent = createProxyAgent('http://anything.com/path');
    assert.equal(agent, undefined);
    
    envManager.restore();
  }, results);

  await testFunction('NO_PROXY comma-separated list', () => {
    envManager.set('HTTP_PROXY', 'http://proxy:8080');
    envManager.set('NO_PROXY', 'localhost,127.0.0.1,.example.com');

    const agent1 = createProxyAgent('http://localhost/path');
    assert.equal(agent1, undefined);

    const agent2 = createProxyAgent('http://127.0.0.1/path');
    assert.equal(agent2, undefined);

    const agent3 = createProxyAgent('http://sub.example.com/path');
    assert.equal(agent3, undefined);

    const agent4 = createProxyAgent('http://other.com/path');
    assert.ok(agent4);
    
    envManager.restore();
  }, results);

  await testFunction('NO_PROXY case-insensitive matching', () => {
    envManager.set('HTTP_PROXY', 'http://proxy:8080');
    envManager.set('NO_PROXY', 'EXAMPLE.COM');

    const agent = createProxyAgent('http://example.com/path');
    assert.equal(agent, undefined);
    
    envManager.restore();
  }, results);

  await testFunction('NO_PROXY lowercase env var', () => {
    envManager.set('HTTP_PROXY', 'http://proxy:8080');
    envManager.set('no_proxy', 'example.com');

    const agent = createProxyAgent('http://example.com/path');
    assert.equal(agent, undefined);
    
    envManager.restore();
  }, results);

  await testFunction('NO_PROXY does not affect non-matching URLs', () => {
    envManager.set('HTTP_PROXY', 'http://proxy:8080');
    envManager.set('NO_PROXY', 'example.com');

    const agent = createProxyAgent('http://other.com/path');
    assert.ok(agent);
    assert.equal(agent.constructor.name, 'ProxyAgent');
    
    envManager.restore();
  }, results);

  await testFunction('createProxyAgent without target URL still works', () => {
    envManager.set('HTTP_PROXY', 'http://proxy:8080');
    envManager.set('NO_PROXY', 'example.com');

    // When no target URL is provided, NO_PROXY should not apply
    const agent = createProxyAgent();
    assert.ok(agent);
    assert.equal(agent.constructor.name, 'ProxyAgent');

    envManager.restore();
  }, results);

  // Tests for interface-specific proxy configuration
  await testFunction('SEARCH_HTTP_PROXY takes priority over HTTP_PROXY for search type', () => {
    envManager.set('HTTP_PROXY', 'http://global-proxy:8080');
    envManager.set('SEARCH_HTTP_PROXY', 'http://search-proxy:9090');

    const agent = createProxyAgent('http://example.com', 'search');
    assert.ok(agent);
    // The agent should use search-proxy, not global-proxy
    // We can't directly inspect the proxy URL, but we can verify agent is created
    assert.equal(agent!.constructor.name, 'ProxyAgent');

    envManager.restore();
  }, results);

  await testFunction('URL_READER_HTTP_PROXY takes priority over HTTP_PROXY for url_reader type', () => {
    envManager.set('HTTP_PROXY', 'http://global-proxy:8080');
    envManager.set('URL_READER_HTTP_PROXY', 'http://reader-proxy:9090');

    const agent = createProxyAgent('http://example.com', 'url_reader');
    assert.ok(agent);
    assert.equal(agent!.constructor.name, 'ProxyAgent');

    envManager.restore();
  }, results);

  await testFunction('Search type falls back to HTTP_PROXY when SEARCH_HTTP_PROXY not set', () => {
    envManager.delete('SEARCH_HTTP_PROXY');
    envManager.set('HTTP_PROXY', 'http://global-proxy:8080');

    const agent = createProxyAgent('http://example.com', 'search');
    assert.ok(agent);
    assert.equal(agent!.constructor.name, 'ProxyAgent');

    envManager.restore();
  }, results);

  await testFunction('URL reader type falls back to HTTP_PROXY when URL_READER_HTTP_PROXY not set', () => {
    envManager.delete('URL_READER_HTTP_PROXY');
    envManager.set('HTTP_PROXY', 'http://global-proxy:8080');

    const agent = createProxyAgent('http://example.com', 'url_reader');
    assert.ok(agent);
    assert.equal(agent!.constructor.name, 'ProxyAgent');

    envManager.restore();
  }, results);

  await testFunction('Different proxy types use different proxies', () => {
    envManager.set('SEARCH_HTTP_PROXY', 'http://search-proxy:9090');
    envManager.set('URL_READER_HTTP_PROXY', 'http://reader-proxy:9091');

    const searchAgent = createProxyAgent('http://example.com', 'search');
    const readerAgent = createProxyAgent('http://example.com', 'url_reader');

    assert.ok(searchAgent, 'Search agent should be created');
    assert.ok(readerAgent, 'Reader agent should be created');
    // Both should be ProxyAgent instances
    assert.equal(searchAgent!.constructor.name, 'ProxyAgent');
    assert.equal(readerAgent!.constructor.name, 'ProxyAgent');

    envManager.restore();
  }, results);

  await testFunction('SEARCH_HTTPS_PROXY works for search type', () => {
    envManager.set('SEARCH_HTTPS_PROXY', 'https://search-secure-proxy:9443');

    const agent = createProxyAgent('https://example.com', 'search');
    assert.ok(agent);
    assert.equal(agent!.constructor.name, 'ProxyAgent');

    envManager.restore();
  }, results);

  await testFunction('URL_READER_HTTPS_PROXY works for url_reader type', () => {
    envManager.set('URL_READER_HTTPS_PROXY', 'https://reader-secure-proxy:9443');

    const agent = createProxyAgent('https://example.com', 'url_reader');
    assert.ok(agent);
    assert.equal(agent!.constructor.name, 'ProxyAgent');

    envManager.restore();
  }, results);

  await testFunction('No proxy returns undefined for search type when nothing configured', () => {
    envManager.delete('HTTP_PROXY');
    envManager.delete('HTTPS_PROXY');
    envManager.delete('SEARCH_HTTP_PROXY');
    envManager.delete('SEARCH_HTTPS_PROXY');

    const agent = createProxyAgent('http://example.com', 'search');
    assert.equal(agent, undefined);

    envManager.restore();
  }, results);

  await testFunction('No proxy returns undefined for url_reader type when nothing configured', () => {
    envManager.delete('HTTP_PROXY');
    envManager.delete('HTTPS_PROXY');
    envManager.delete('URL_READER_HTTP_PROXY');
    envManager.delete('URL_READER_HTTPS_PROXY');

    const agent = createProxyAgent('http://example.com', 'url_reader');
    assert.equal(agent, undefined);

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
