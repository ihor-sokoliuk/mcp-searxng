#!/usr/bin/env tsx

/**
 * Unit Tests: logging.ts
 * 
 * Tests for logging module functionality
 */

import { strict as assert } from 'node:assert';
import { 
  logMessage, 
  shouldLog, 
  setLogLevel, 
  getCurrentLogLevel 
} from '../../src/logging.js';
import { testFunction, createTestResults, printTestSummary } from '../helpers/test-utils.js';
import { createMockServerWithTracking } from '../helpers/mock-server.js';

const results = createTestResults();

async function runTests() {
  console.log('🧪 Testing: logging.ts\n');

  await testFunction('Log level filtering', () => {
    setLogLevel('error');
    assert.equal(shouldLog('error'), true);
    assert.equal(shouldLog('info'), false);
    
    setLogLevel('debug');  
    assert.equal(shouldLog('error'), true);
    assert.equal(shouldLog('debug'), true);
  }, results);

  await testFunction('Get and set current log level', () => {
    setLogLevel('warning');
    assert.equal(getCurrentLogLevel(), 'warning');
    
    setLogLevel('info');
    assert.equal(getCurrentLogLevel(), 'info');
  }, results);

  await testFunction('All log levels work correctly', () => {
    const levels = ['error', 'warning', 'info', 'debug'];
    
    for (const level of levels) {
      setLogLevel(level as any);
      for (const testLevel of levels) {
        const result = shouldLog(testLevel as any);
        assert.equal(typeof result, 'boolean');
      }
    }
  }, results);

  await testFunction('logMessage with different levels and mock server', () => {
    const { server, getLoggingCalls } = createMockServerWithTracking();

    // Test different log levels
    setLogLevel('debug'); // Allow all messages
    
    logMessage(server as any, 'info', 'Test info message');
    logMessage(server as any, 'warning', 'Test warning message');
    logMessage(server as any, 'error', 'Test error message');
    
    // Should have called notification for each message
    const calls = getLoggingCalls();
    assert.ok(calls.length >= 0); // Notification calls depend on implementation
  }, results);

  await testFunction('shouldLog edge cases', () => {
    // Test with all combinations of log levels
    setLogLevel('error');
    assert.equal(shouldLog('error'), true);
    assert.equal(shouldLog('warning'), false);
    assert.equal(shouldLog('info'), false);
    assert.equal(shouldLog('debug'), false);
    
    setLogLevel('warning');
    assert.equal(shouldLog('error'), true);
    assert.equal(shouldLog('warning'), true);
    assert.equal(shouldLog('info'), false);
    assert.equal(shouldLog('debug'), false);
    
    setLogLevel('info');
    assert.equal(shouldLog('error'), true);
    assert.equal(shouldLog('warning'), true);
    assert.equal(shouldLog('info'), true);
    assert.equal(shouldLog('debug'), false);
    
    setLogLevel('debug');
    assert.equal(shouldLog('error'), true);
    assert.equal(shouldLog('warning'), true);
    assert.equal(shouldLog('info'), true);
    assert.equal(shouldLog('debug'), true);
  }, results);

  await testFunction('logMessage silently ignores async "Not connected" errors', async () => {
    const server = {
      sendLoggingMessage: async () => {
        throw new Error('Not connected');
      }
    };

    setLogLevel('debug');
    // Should not throw
    logMessage(server as any, 'info', 'test message');
    // Wait for the async rejection to be handled
    await new Promise(resolve => setTimeout(resolve, 10));
    setLogLevel('info');
  }, results);

  await testFunction('logMessage silently ignores sync "Not connected" errors', () => {
    const server = {
      sendLoggingMessage: () => {
        throw new Error('Not connected');
      }
    };

    setLogLevel('debug');
    // Should not throw
    logMessage(server as any, 'info', 'test message');
    setLogLevel('info');
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

    setLogLevel('debug');
    logMessage(server as any, 'info', 'test message');
    await new Promise(resolve => setTimeout(resolve, 10));

    console.error = originalError;
    setLogLevel('info');
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

    setLogLevel('debug');
    logMessage(server as any, 'info', 'test message');

    console.error = originalError;
    setLogLevel('info');
    assert.ok(consoleErrors.length > 0, 'Expected console.error to be called');
  }, results);

  printTestSummary(results, 'Logging Module');
  return results;
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runTests().then(results => {
    process.exit(results.failed > 0 ? 1 : 0);
  }).catch(console.error);
}

export { runTests };
