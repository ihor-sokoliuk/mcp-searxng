#!/usr/bin/env tsx

/**
 * Unit Tests: resources.ts
 * 
 * Tests for resource generation
 */

import { strict as assert } from 'node:assert';
import { createConfigResource, createHelpResource } from '../../src/resources.js';
import { testFunction, createTestResults, printTestSummary } from '../helpers/test-utils.js';

const results = createTestResults();

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
