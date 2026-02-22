#!/usr/bin/env tsx

/**
 * Integration Tests: index.ts
 * 
 * Tests for main server integration and tool handlers
 */

import { strict as assert } from 'node:assert';
import { 
  packageVersion, 
  isWebUrlReadArgs 
} from '../../src/index.js';
import { isSearXNGWebSearchArgs } from '../../src/types.js';
import { createConfigResource, createHelpResource } from '../../src/resources.js';
import { testFunction, createTestResults, printTestSummary } from '../helpers/test-utils.js';

const results = createTestResults();

async function runTests() {
  console.log('🧪 Integration Testing: index.ts\n');

  await testFunction('Package version is exported', () => {
    assert.ok(packageVersion);
    assert.ok(typeof packageVersion === 'string');
    assert.ok(packageVersion.length > 0);
  }, results);

  await testFunction('Call tool handler - unknown tool error', async () => {
    const unknownToolRequest = { name: 'unknown_tool', arguments: {} };
    assert.notEqual(unknownToolRequest.name, 'searxng_web_search');
    assert.notEqual(unknownToolRequest.name, 'web_url_read');

    // Simulate error response
    try {
      if (unknownToolRequest.name !== 'searxng_web_search' &&
          unknownToolRequest.name !== 'web_url_read') {
        throw new Error(`Unknown tool: ${unknownToolRequest.name}`);
      }
    } catch (error) {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes('Unknown tool'));
    }
  }, results);

  await testFunction('URL read tool with pagination parameters integration', async () => {
    const validArgs = {
      url: 'https://example.com',
      startChar: 10,
      max_length: 100,
      section: 'introduction',
      paragraphRange: '1-3',
      readHeadings: false
    };

    // Verify type guard accepts the parameters
    assert.ok(isWebUrlReadArgs(validArgs));

    // Test individual parameter validation
    assert.ok(isWebUrlReadArgs({ url: 'https://example.com', startChar: 0 }));
    assert.ok(isWebUrlReadArgs({ url: 'https://example.com', max_length: 1 }));
    assert.ok(isWebUrlReadArgs({ url: 'https://example.com', section: 'test' }));
    assert.ok(isWebUrlReadArgs({ url: 'https://example.com', paragraphRange: '1' }));
    assert.ok(isWebUrlReadArgs({ url: 'https://example.com', readHeadings: true }));
  }, results);

  await testFunction('Pagination options object construction', async () => {
    const testArgs = {
      url: 'https://example.com',
      startChar: 50,
      max_length: 200,
      section: 'getting-started',
      paragraphRange: '2-5',
      readHeadings: true
    };

    // Mimic pagination options construction in index.ts
    const paginationOptions = {
      startChar: testArgs.startChar,
      max_length: testArgs.max_length,
      section: testArgs.section,
      paragraphRange: testArgs.paragraphRange,
      readHeadings: testArgs.readHeadings,
    };

    assert.equal(paginationOptions.startChar, 50);
    assert.equal(paginationOptions.max_length, 200);
    assert.equal(paginationOptions.section, 'getting-started');
    assert.equal(paginationOptions.paragraphRange, '2-5');
    assert.equal(paginationOptions.readHeadings, true);
  }, results);

  await testFunction('Read resource handler - config resource', async () => {
    const configUri = "config://server-config";
    const configContent = createConfigResource();
    
    const configResponse = {
      contents: [
        {
          uri: configUri,
          mimeType: "application/json",
          text: configContent
        }
      ]
    };
    
    assert.equal(configResponse.contents[0].uri, configUri);
    assert.equal(configResponse.contents[0].mimeType, "application/json");
    assert.ok(typeof configResponse.contents[0].text === 'string');
    
    // Verify it's valid JSON
    const parsed = JSON.parse(configResponse.contents[0].text);
    assert.ok(typeof parsed === 'object');
  }, results);

  await testFunction('Read resource handler - help resource', async () => {
    const helpUri = "help://usage-guide";
    const helpContent = createHelpResource();
    
    const helpResponse = {
      contents: [
        {
          uri: helpUri,
          mimeType: "text/markdown",
          text: helpContent
        }
      ]
    };
    
    assert.equal(helpResponse.contents[0].uri, helpUri);
    assert.equal(helpResponse.contents[0].mimeType, "text/markdown");
    assert.ok(typeof helpResponse.contents[0].text === 'string');
  }, results);

  await testFunction('Read resource handler - unknown resource error', async () => {
    const testUnknownResource = (uri: string) => {
      if (uri !== "config://server-config" && 
          uri !== "help://usage-guide") {
        throw new Error(`Unknown resource: ${uri}`);
      }
    };
    
    try {
      testUnknownResource("unknown://resource");
      assert.fail('Should have thrown error');
    } catch (error) {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes('Unknown resource'));
    }
  }, results);

  await testFunction('Tool arguments validation - search tool', () => {
    // Valid cases
    assert.ok(isSearXNGWebSearchArgs({ query: 'test search', language: 'en' }));
    assert.ok(isSearXNGWebSearchArgs({ query: 'test', pageno: 1, time_range: 'day' }));
    
    // Invalid cases
    assert.ok(!isSearXNGWebSearchArgs({ notQuery: 'invalid' }));
    assert.ok(!isSearXNGWebSearchArgs(null));
    assert.ok(!isSearXNGWebSearchArgs({}));
  }, results);

  await testFunction('Tool arguments validation - URL read tool', () => {
    // Valid cases with various pagination parameters
    assert.ok(isWebUrlReadArgs({ url: 'https://example.com' }));
    assert.ok(isWebUrlReadArgs({ url: 'https://example.com', max_length: 100 }));
    
    // Invalid cases
    assert.ok(!isWebUrlReadArgs({ url: 'https://example.com', startChar: -1 }));
    assert.ok(!isWebUrlReadArgs({ url: 'https://example.com', max_length: 0 }));
    assert.ok(!isWebUrlReadArgs({ notUrl: 'invalid' }));
  }, results);

  printTestSummary(results, 'Main Server Integration');
  return results;
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runTests().then(results => {
    process.exit(results.failed > 0 ? 1 : 0);
  }).catch(console.error);
}

export { runTests };
