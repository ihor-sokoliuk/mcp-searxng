#!/usr/bin/env tsx

/**
 * Unit Tests: error-handler.ts
 * 
 * Tests for error handling utilities
 */

import { strict as assert } from 'node:assert';
import {
  MCPSearXNGError,
  createConfigurationError,
  createNetworkError,
  createServerError,
  createJSONError,
  createDataError,
  createNoResultsMessage,
  createURLFormatError,
  createContentError,
  createConversionError,
  createTimeoutError,
  createEmptyContentWarning,
  createUnexpectedError,
  validateEnvironment
} from '../../src/error-handler.js';
import { testFunction, createTestResults, printTestSummary } from '../helpers/test-utils.js';
import { EnvManager } from '../helpers/env-utils.js';

const results = createTestResults();
const envManager = new EnvManager();

async function runTests() {
  console.log('🧪 Testing: error-handler.ts\n');

  await testFunction('MCPSearXNGError custom error class', () => {
    const error = new MCPSearXNGError('test error');
    assert.ok(error instanceof Error);
    assert.equal(error.name, 'MCPSearXNGError');
    assert.equal(error.message, 'test error');
  }, results);

  await testFunction('createConfigurationError', () => {
    const error = createConfigurationError('test config error');
    assert.ok(error instanceof MCPSearXNGError);
    assert.ok(error.message.includes('Configuration Error'));
    assert.ok(error.message.includes('test config error'));
  }, results);

  await testFunction('createNetworkError with different codes', () => {
    const errors = [
      { code: 'ECONNREFUSED', message: 'Connection refused', expectedText: 'Connection Error' },
      { code: 'ETIMEDOUT', message: 'Timeout', expectedText: 'Timeout Error' },
      { code: 'EAI_NONAME', message: 'DNS error', expectedText: 'DNS Error' },
      { code: 'ENOTFOUND', message: 'DNS error', expectedText: 'DNS Error' },
      { message: 'certificate error', expectedText: 'SSL Error' }
    ];
    
    for (const testError of errors) {
      const context = { url: 'https://example.com' };
      const error = createNetworkError(testError, context);
      assert.ok(error instanceof MCPSearXNGError);
      if (testError.expectedText) {
        assert.ok(error.message.includes(testError.expectedText), 
          `Expected "${testError.expectedText}" in error message, got: ${error.message}`);
      }
    }
  }, results);

  await testFunction('createNetworkError edge cases', () => {
    const networkErrors = [
      { code: 'EHOSTUNREACH', message: 'Host unreachable' },
      { code: 'ECONNRESET', message: 'Connection reset' },
      { code: 'EPIPE', message: 'Broken pipe' },
    ];
    
    for (const testError of networkErrors) {
      const context = { url: 'https://example.com' };
      const error = createNetworkError(testError, context);
      assert.ok(error instanceof MCPSearXNGError);
      assert.ok(error.message.length > 0);
    }
  }, results);

  await testFunction('createServerError with different status codes', () => {
    const statusCodes = [403, 404, 429, 500, 502, 503];
    
    for (const status of statusCodes) {
      const context = { url: 'https://example.com' };
      const error = createServerError(status, 'Error', 'Response body', context);
      assert.ok(error instanceof MCPSearXNGError);
      assert.ok(error.message.includes(String(status)));
    }
  }, results);

  await testFunction('Specialized error creators', () => {
    const context = { searxngUrl: 'https://searx.example.com' };
    
    assert.ok(createJSONError('invalid json', context) instanceof MCPSearXNGError);
    assert.ok(createDataError({}, context) instanceof MCPSearXNGError);
    assert.ok(createURLFormatError('invalid-url') instanceof MCPSearXNGError);
    assert.ok(createContentError('test error', 'https://example.com') instanceof MCPSearXNGError);
    assert.ok(createConversionError(new Error('test'), 'https://example.com', '<html>') instanceof MCPSearXNGError);
    assert.ok(createTimeoutError(5000, 'https://example.com') instanceof MCPSearXNGError);
    assert.ok(createUnexpectedError(new Error('test'), context) instanceof MCPSearXNGError);
  }, results);

  await testFunction('Message creators', () => {
    assert.ok(typeof createNoResultsMessage('test query') === 'string');
    assert.ok(createNoResultsMessage('test').includes('No results found'));
    
    const warning = createEmptyContentWarning('https://example.com', 100, '<html>');
    assert.ok(typeof warning === 'string');
    assert.ok(warning.includes('Content Warning'));
  }, results);

  await testFunction('createEmptyContentWarning with various content', () => {
    const contents = ['', '<html></html>', '<div>content</div>', 'plain text'];
    for (const content of contents) {
      const warning = createEmptyContentWarning('https://test.com', content.length, content);
      assert.ok(typeof warning === 'string');
    }
  }, results);

  await testFunction('validateEnvironment success', () => {
    envManager.set('SEARXNG_URL', 'https://valid-url.com');
    
    const result = validateEnvironment();
    assert.equal(result, null);
    
    envManager.restore();
  }, results);

  await testFunction('validateEnvironment - missing SEARXNG_URL', () => {
    envManager.delete('SEARXNG_URL');
    
    const result = validateEnvironment();
    assert.ok(typeof result === 'string');
    assert.ok(result!.includes('SEARXNG_URL not set'));
    
    envManager.restore();
  }, results);

  await testFunction('validateEnvironment - invalid URL format', () => {
    envManager.set('SEARXNG_URL', 'not-a-valid-url');
    
    const result = validateEnvironment();
    assert.ok(typeof result === 'string');
    assert.ok(result!.includes('invalid format') || result!.includes('invalid protocol') || result!.includes('Configuration Issues'));
    
    envManager.restore();
  }, results);

  await testFunction('validateEnvironment - invalid auth configuration', () => {
    envManager.set('SEARXNG_URL', 'https://valid.com');
    envManager.set('AUTH_USERNAME', 'user');
    envManager.delete('AUTH_PASSWORD');
    
    const result = validateEnvironment();
    assert.ok(typeof result === 'string');
    assert.ok(result!.includes('AUTH_PASSWORD missing'));
    
    envManager.restore();
  }, results);

  await testFunction('validateEnvironment - password without username', () => {
    envManager.set('SEARXNG_URL', 'https://valid.com');
    envManager.delete('AUTH_USERNAME');
    envManager.set('AUTH_PASSWORD', 'password');
    
    const result = validateEnvironment();
    assert.ok(typeof result === 'string');
    assert.ok(result!.includes('AUTH_USERNAME missing'));
    
    envManager.restore();
  }, results);

  await testFunction('validateEnvironment - invalid URL protocols', () => {
    const invalidUrls = [
      'htp://invalid',
      'ftp://invalid',
      'javascript:alert(1)',
    ];
    
    for (const invalidUrl of invalidUrls) {
      envManager.set('SEARXNG_URL', invalidUrl);
      const result = validateEnvironment();
      assert.ok(typeof result === 'string');
    }
    
    envManager.restore();
  }, results);

  printTestSummary(results, 'Error Handler Module');
  return results;
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runTests().then(results => {
    process.exit(results.failed > 0 ? 1 : 0);
  }).catch(console.error);
}

export { runTests };
