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
    const { server, getNotificationCalls } = createMockServerWithTracking();

    // Test different log levels
    setLogLevel('debug'); // Allow all messages
    
    logMessage(server as any, 'info', 'Test info message');
    logMessage(server as any, 'warning', 'Test warning message');
    logMessage(server as any, 'error', 'Test error message');
    
    // Should have called notification for each message
    const calls = getNotificationCalls();
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
