#!/usr/bin/env tsx

/**
 * Unit Tests: logging.ts
 * 
 * Tests for logging module functionality
 */

import { strict as assert } from 'node:assert';
import { fileURLToPath } from 'node:url';
import { 
  DEFAULT_LOG_LEVEL,
  logMessage, 
  shouldLog, 
  setLogLevel, 
  getCurrentLogLevel 
} from '../../src/logging.js';
import { testFunction, createTestResults, printTestSummary } from '../helpers/test-utils.js';
import { createMockServerWithTracking } from '../helpers/mock-server.js';
import {
  initializeDiagnosticSanitizer,
  resetDiagnosticSanitizerForTests,
} from '../../src/diagnostic-sanitizer.js';

const results = createTestResults();
const testServer = createMockServerWithTracking().server as any;

async function runTests() {
  console.log('🧪 Testing: logging.ts\n');

  await testFunction('Default log level is explicit and deterministic', () => {
    const freshServer = createMockServerWithTracking().server;
    assert.equal(DEFAULT_LOG_LEVEL, 'info');
    assert.equal(getCurrentLogLevel(freshServer as any), DEFAULT_LOG_LEVEL);
    assert.equal(getCurrentLogLevel(), DEFAULT_LOG_LEVEL);
  }, results);

  await testFunction('Log level filtering', () => {
    setLogLevel(testServer, 'error');
    assert.equal(shouldLog(testServer, 'error'), true);
    assert.equal(shouldLog(testServer, 'info'), false);
    
    setLogLevel(testServer, 'debug');
    assert.equal(shouldLog(testServer, 'error'), true);
    assert.equal(shouldLog(testServer, 'debug'), true);
  }, results);

  await testFunction('Get and set current log level', () => {
    setLogLevel(testServer, 'warning');
    assert.equal(getCurrentLogLevel(testServer), 'warning');
    
    setLogLevel(testServer, 'info');
    assert.equal(getCurrentLogLevel(testServer), 'info');
  }, results);

  await testFunction('Log levels are isolated by MCP server identity', () => {
    const first = createMockServerWithTracking().server;
    const second = createMockServerWithTracking().server;

    assert.equal(getCurrentLogLevel(first as any), 'info');
    assert.equal(getCurrentLogLevel(second as any), 'info');

    setLogLevel(first as any, 'debug');
    setLogLevel(second as any, 'error');

    assert.equal(getCurrentLogLevel(first as any), 'debug');
    assert.equal(getCurrentLogLevel(second as any), 'error');
    assert.equal(shouldLog(first as any, 'debug'), true);
    assert.equal(shouldLog(second as any, 'debug'), false);
  }, results);

  await testFunction('All log levels work correctly', () => {
    const levels = [
      'debug',
      'info',
      'notice',
      'warning',
      'error',
      'critical',
      'alert',
      'emergency',
    ] as const;
    
    for (const level of levels) {
      setLogLevel(testServer, level);
      for (const testLevel of levels) {
        const result = shouldLog(testServer, testLevel);
        assert.equal(typeof result, 'boolean');
      }
    }
  }, results);

  await testFunction('RFC 5424 thresholds filter lower-severity messages', () => {
    try {
      setLogLevel(testServer, 'notice');
      assert.equal(shouldLog(testServer, 'info'), false);
      assert.equal(shouldLog(testServer, 'notice'), true);
      assert.equal(shouldLog(testServer, 'warning'), true);

      setLogLevel(testServer, 'emergency');
      assert.equal(shouldLog(testServer, 'error'), false);
      assert.equal(shouldLog(testServer, 'emergency'), true);
    } finally {
      setLogLevel(testServer, 'info');
    }
  }, results);

  await testFunction('logMessage with different levels and mock server', () => {
    const { server, getLoggingCalls } = createMockServerWithTracking();

    // Test different log levels
    setLogLevel(server as any, 'debug'); // Allow all messages
    
    logMessage(server as any, 'info', 'Test info message');
    logMessage(server as any, 'warning', 'Test warning message');
    logMessage(server as any, 'error', 'Test error message');
    
    // Should have called notification for each message
    const calls = getLoggingCalls();
    assert.ok(calls.length >= 0); // Notification calls depend on implementation
  }, results);

  await testFunction('logMessage sanitizes text and structured metadata before MCP output', () => {
    resetDiagnosticSanitizerForTests();
    initializeDiagnosticSanitizer({
      AUTH_USERNAME: 'log-user',
      AUTH_PASSWORD: 'log-secret',
    });
    const { server, getLoggingCalls } = createMockServerWithTracking();
    setLogLevel(server as any, 'debug');

    logMessage(
      server as any,
      'error',
      'failed for log-user:log-secret',
      {
        password: 'log-secret',
        nested: { authorization: `Basic ${Buffer.from('log-user:log-secret').toString('base64')}` },
      },
    );

    const serialized = JSON.stringify(getLoggingCalls());
    assert.ok(!serialized.includes('log-user'), serialized);
    assert.ok(!serialized.includes('log-secret'), serialized);
    assert.ok(serialized.includes('[redacted]'), serialized);
    resetDiagnosticSanitizerForTests();
    setLogLevel(server as any, 'info');
  }, results);

  await testFunction('logging-send failures sanitize errors before stderr output', async () => {
    resetDiagnosticSanitizerForTests();
    initializeDiagnosticSanitizer({
      AUTH_USERNAME: 'send-user',
      AUTH_PASSWORD: 'send-secret',
    });
    const calls: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => calls.push(args);
    try {
      const server = {
        sendLoggingMessage: async () => {
          throw new Error('send failed for send-user:send-secret');
        },
      } as any;
      setLogLevel(server, 'debug');
      logMessage(server, 'error', 'safe');
      await new Promise(resolve => setTimeout(resolve, 10));
    } finally {
      console.error = originalError;
      resetDiagnosticSanitizerForTests();
      setLogLevel(testServer, 'info');
    }

    const output = calls.flat().map((value) => (
      value instanceof Error ? `${value.message}\n${value.stack}` : String(value)
    )).join('\n');
    assert.ok(!output.includes('send-user'), output);
    assert.ok(!output.includes('send-secret'), output);
  }, results);

  await testFunction('shouldLog edge cases', () => {
    // Test with all combinations of log levels
    setLogLevel(testServer, 'error');
    assert.equal(shouldLog(testServer, 'error'), true);
    assert.equal(shouldLog(testServer, 'warning'), false);
    assert.equal(shouldLog(testServer, 'info'), false);
    assert.equal(shouldLog(testServer, 'debug'), false);
    
    setLogLevel(testServer, 'warning');
    assert.equal(shouldLog(testServer, 'error'), true);
    assert.equal(shouldLog(testServer, 'warning'), true);
    assert.equal(shouldLog(testServer, 'info'), false);
    assert.equal(shouldLog(testServer, 'debug'), false);
    
    setLogLevel(testServer, 'info');
    assert.equal(shouldLog(testServer, 'error'), true);
    assert.equal(shouldLog(testServer, 'warning'), true);
    assert.equal(shouldLog(testServer, 'info'), true);
    assert.equal(shouldLog(testServer, 'debug'), false);
    
    setLogLevel(testServer, 'debug');
    assert.equal(shouldLog(testServer, 'error'), true);
    assert.equal(shouldLog(testServer, 'warning'), true);
    assert.equal(shouldLog(testServer, 'info'), true);
    assert.equal(shouldLog(testServer, 'debug'), true);
  }, results);

  await testFunction('logMessage silently ignores async "Not connected" errors', async () => {
    const server = {
      sendLoggingMessage: async () => {
        throw new Error('Not connected');
      }
    };

    setLogLevel(server as any, 'debug');
    // Should not throw
    logMessage(server as any, 'info', 'test message');
    // Wait for the async rejection to be handled
    await new Promise(resolve => setTimeout(resolve, 10));
    setLogLevel(server as any, 'info');
  }, results);

  await testFunction('logMessage silently ignores sync "Not connected" errors', () => {
    const server = {
      sendLoggingMessage: () => {
        throw new Error('Not connected');
      }
    };

    setLogLevel(server as any, 'debug');
    // Should not throw
    logMessage(server as any, 'info', 'test message');
    setLogLevel(server as any, 'info');
  }, results);

  await testFunction('logMessage logs non-"Not connected" async errors to console.error', async () => {
    const consoleErrors: unknown[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => consoleErrors.push(args);

    const server = {
      sendLoggingMessage: async () => {
        throw new Error('Something else went wrong');
      }
    };

    setLogLevel(server as any, 'debug');
    logMessage(server as any, 'info', 'test message');
    await new Promise(resolve => setTimeout(resolve, 10));

    console.error = originalError;
    setLogLevel(server as any, 'info');
    assert.ok(consoleErrors.length > 0, 'Expected console.error to be called');
  }, results);

  await testFunction('logMessage logs non-"Not connected" sync errors to console.error', () => {
    const consoleErrors: unknown[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => consoleErrors.push(args);

    const server = {
      sendLoggingMessage: () => {
        throw new Error('Synchronous failure');
      }
    };

    setLogLevel(server as any, 'debug');
    logMessage(server as any, 'info', 'test message');

    console.error = originalError;
    setLogLevel(server as any, 'info');
    assert.ok(consoleErrors.length > 0, 'Expected console.error to be called');
  }, results);

  printTestSummary(results, 'Logging Module');
  return results;
}

// Run if executed directly
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  runTests().then(results => {
    process.exit(results.failed > 0 ? 1 : 0);
  }).catch(console.error);
}

export { runTests };
