#!/usr/bin/env tsx

/**
 * Unit Tests: error-handler.ts
 * 
 * Tests for error handling utilities
 */

import { strict as assert } from 'node:assert';
import { fileURLToPath } from 'node:url';
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
  validateEnvironment,
  handleUncaughtException,
  handleUnhandledRejection
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
      { message: 'certificate error', expectedText: 'SSL' }
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
    
    assert.ok(createJSONError('invalid json') instanceof MCPSearXNGError);
    assert.ok(createDataError() instanceof MCPSearXNGError);
    assert.ok(createURLFormatError('invalid-url') instanceof MCPSearXNGError);
    assert.ok(createContentError('test error', 'https://example.com') instanceof MCPSearXNGError);
    assert.ok(createConversionError('https://example.com') instanceof MCPSearXNGError);
    assert.ok(createTimeoutError(5000, 'https://example.com') instanceof MCPSearXNGError);
    assert.ok(createUnexpectedError(new Error('test'), context) instanceof MCPSearXNGError);
  }, results);

  await testFunction('Message creators', () => {
    assert.ok(typeof createNoResultsMessage('test query') === 'string');
    assert.ok(createNoResultsMessage('test').includes('No results found'));
    
    const warning = createEmptyContentWarning('https://example.com');
    assert.ok(typeof warning === 'string');
    assert.ok(warning.includes('Content Warning'));
  }, results);

  await testFunction('createEmptyContentWarning includes the URL', () => {
    const warning = createEmptyContentWarning('https://test.com');
    // Exact-match the full message (not url.includes) — a substring URL check
    // trips CodeQL's incomplete-URL-sanitization rule and asserts less anyway.
    assert.equal(
      warning,
      '📄 Content Warning: Page fetched but appears empty after conversion (https://test.com). May contain only media or require JavaScript.'
    );
  }, results);

  await testFunction('validateEnvironment success', () => {
    envManager.set('SEARXNG_URL', 'https://valid-url.com');
    
    const result = validateEnvironment();
    assert.equal(result, null);
    
    envManager.restore();
  }, results);

  await testFunction('validateEnvironment accepts valid multi-URL SEARXNG_URL list', () => {
    envManager.set('SEARXNG_URL', 'https://one.example.com; http://two.example.com:8080 ');

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

  await testFunction('validateEnvironment - invalid entry in multi-URL list reports offending entry', () => {
    envManager.set('SEARXNG_URL', 'https://valid.example.com;not-a-valid-url');

    const result = validateEnvironment();
    assert.ok(typeof result === 'string');
    assert.ok(result!.includes('Configuration Issues'));
    assert.ok(result!.includes('not-a-valid-url'));

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

  await testFunction('validateEnvironment - empty-only multi-URL list is treated as not set', () => {
    for (const emptyList of ['', ';', ' ; ']) {
      envManager.set('SEARXNG_URL', emptyList);
      const result = validateEnvironment();
      assert.ok(typeof result === 'string');
      assert.ok(result!.includes('SEARXNG_URL not set'));
    }

    envManager.restore();
  }, results);

  await testFunction('createNetworkError with searxngUrl context includes SEARXNG_URL guidance', () => {
    // Covers the truthy branch of the searxngUrl ternary
    const error = { message: 'fetch failed' };
    const context = {
      url: 'https://searx.example.com/search',
      searxngUrl: 'https://searx.example.com'
    };

    const result = createNetworkError(error, context);
    assert.ok(result instanceof MCPSearXNGError);
    assert.ok(
      result.message.includes('SEARXNG_URL'),
      `Expected SEARXNG_URL guidance, got: ${result.message}`
    );
  }, results);

  await testFunction('createNetworkError detects TLS error via error.cause.code', () => {
    const error = {
      message: 'fetch failed',
      cause: { code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', message: 'unable to get local issuer certificate' }
    };
    const result = createNetworkError(error, { url: 'https://example.com' });
    assert.ok(result instanceof MCPSearXNGError);
    assert.ok(
      result.message.includes('SSL') || result.message.includes('TLS') || result.message.includes('Certificate'),
      `Expected SSL/TLS/Certificate in message, got: ${result.message}`
    );
  }, results);

  await testFunction('createNetworkError TLS error includes error code in message', () => {
    const error = {
      message: 'fetch failed',
      cause: { code: 'DEPTH_ZERO_SELF_SIGNED_CERT', message: 'self signed certificate' }
    };
    const result = createNetworkError(error, { url: 'https://example.com' });
    assert.ok(result.message.includes('DEPTH_ZERO_SELF_SIGNED_CERT'), `Expected code in message, got: ${result.message}`);
  }, results);

  // --- Process-level crash handlers ---
  // process.exit / console.error are stubbed so the handlers can be exercised
  // without killing the test process or printing to the real console.
  function captureExitAndError(fn: () => void): { exitCode: number | undefined; calls: unknown[][] } {
    const originalExit = process.exit;
    const originalError = console.error;
    let exitCode: number | undefined;
    const calls: unknown[][] = [];
    process.exit = ((code?: number) => { exitCode = code; }) as unknown as typeof process.exit;
    console.error = (...args: unknown[]) => { calls.push(args); };
    try {
      fn();
    } finally {
      process.exit = originalExit;
      console.error = originalError;
    }
    return { exitCode, calls };
  }

  await testFunction('handleUncaughtException logs the error and exits with code 1', () => {
    const err = new Error('boom');
    const { exitCode, calls } = captureExitAndError(() => handleUncaughtException(err));
    assert.equal(exitCode, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'Uncaught Exception:');
    assert.equal(calls[0][1], err);
  }, results);

  await testFunction('handleUnhandledRejection logs the reason/promise and exits with code 1', () => {
    const reason = new Error('nope');
    const promise = Promise.reject(reason);
    promise.catch(() => {}); // settle it so the test process sees no real unhandled rejection
    const { exitCode, calls } = captureExitAndError(() => handleUnhandledRejection(reason, promise));
    assert.equal(exitCode, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'Unhandled Rejection at:');
    assert.equal(calls[0][3], reason);
  }, results);

  printTestSummary(results, 'Error Handler Module');
  return results;
}

// Run if executed directly
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  runTests().then(results => {
    process.exit(results.failed > 0 ? 1 : 0);
  }).catch(console.error);
}

export { runTests };
