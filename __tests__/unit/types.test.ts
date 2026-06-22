#!/usr/bin/env tsx

/**
 * Unit Tests: types.ts
 * 
 * Tests for type guards and type definitions
 */

import { strict as assert } from 'node:assert';
import { fileURLToPath } from 'node:url';
import {
  WEB_SEARCH_TOOL,
  READ_URL_TOOL,
  SUGGESTIONS_TOOL,
  INSTANCE_INFO_TOOL,
  LITE_WEB_SEARCH_TOOL,
  LITE_READ_URL_TOOL,
  LITE_SUGGESTIONS_TOOL,
  LITE_INSTANCE_INFO_TOOL,
  isSearXNGWebSearchArgs,
  isSearXNGSearchSuggestionsArgs,
  isSearXNGInstanceInfoArgs,
  SearXNGWeb,
  SearXNGWebResult,
  SearXNGWebInfobox,
} from '../../src/types.js';
import { isWebUrlReadArgs } from '../../src/index.js';
import { testFunction, createTestResults, printTestSummary } from '../helpers/test-utils.js';

const results = createTestResults();

async function runTests() {
  console.log('🧪 Testing: types.ts\n');

  await testFunction('isSearXNGWebSearchArgs type guard - valid cases', () => {
    assert.equal(isSearXNGWebSearchArgs({ query: 'test', language: 'en' }), true);
    assert.equal(isSearXNGWebSearchArgs({ query: 'test search' }), true);
    assert.equal(isSearXNGWebSearchArgs({ query: 'test', pageno: 1, time_range: 'day' }), true);
    assert.equal(isSearXNGWebSearchArgs({ query: 'test', pageno: 1, time_range: 'week', safesearch: 2 }), true);
    assert.equal(isSearXNGWebSearchArgs({ query: 'test', safesearch: 0 }), true);
    assert.equal(isSearXNGWebSearchArgs({ query: 'test', safesearch: 1 }), true);
    assert.equal(isSearXNGWebSearchArgs({ query: 'test', safesearch: '0' }), true);
    assert.equal(isSearXNGWebSearchArgs({ query: 'test', safesearch: '1' }), true);
    assert.equal(isSearXNGWebSearchArgs({ query: 'test', safesearch: '2' }), true);
    assert.equal(isSearXNGWebSearchArgs({ query: 'test', min_score: 0 }), true);
    assert.equal(isSearXNGWebSearchArgs({ query: 'test', min_score: 1 }), true);
    assert.equal(isSearXNGWebSearchArgs({ query: 'test', num_results: 1 }), true);
    assert.equal(isSearXNGWebSearchArgs({ query: 'test', num_results: 20 }), true);
    assert.equal(isSearXNGWebSearchArgs({ query: 'test', engines: 'google,ddg' }), true);
  }, results);

  await testFunction('isSearXNGWebSearchArgs type guard - invalid cases', () => {
    assert.equal(isSearXNGWebSearchArgs({ notQuery: 'test' }), false);
    assert.equal(isSearXNGWebSearchArgs(null), false);
    assert.equal(isSearXNGWebSearchArgs(undefined), false);
    assert.equal(isSearXNGWebSearchArgs('string'), false);
    assert.equal(isSearXNGWebSearchArgs(123), false);
    assert.equal(isSearXNGWebSearchArgs({}), false);
  }, results);

  await testFunction('isSearXNGWebSearchArgs type guard - invalid optional parameters', () => {
    assert.equal(isSearXNGWebSearchArgs({ query: 'test', pageno: 0 }), false);
    assert.equal(isSearXNGWebSearchArgs({ query: 'test', pageno: -1 }), false);
    assert.equal(isSearXNGWebSearchArgs({ query: 'test', pageno: '1' }), false);
    assert.equal(isSearXNGWebSearchArgs({ query: 'test', time_range: 'last week' }), false);
    assert.equal(isSearXNGWebSearchArgs({ query: 'test', language: 123 }), false);
    assert.equal(isSearXNGWebSearchArgs({ query: 'test', safesearch: 3 }), false);
    assert.equal(isSearXNGWebSearchArgs({ query: 'test', safesearch: '3' }), false);
    assert.equal(isSearXNGWebSearchArgs({ query: 'test', safesearch: 'none' }), false);
    assert.equal(isSearXNGWebSearchArgs({ query: 'test', safesearch: 1.5 }), false);
    assert.equal(isSearXNGWebSearchArgs({ query: 'test', min_score: -0.1 }), false);
    assert.equal(isSearXNGWebSearchArgs({ query: 'test', min_score: 1.1 }), false);
    assert.equal(isSearXNGWebSearchArgs({ query: 'test', min_score: Number.NaN }), false);
    assert.equal(isSearXNGWebSearchArgs({ query: 'test', num_results: 0 }), false);
    assert.equal(isSearXNGWebSearchArgs({ query: 'test', num_results: 21 }), false);
    assert.equal(isSearXNGWebSearchArgs({ query: 'test', num_results: 1.5 }), false);
    assert.equal(isSearXNGWebSearchArgs({ query: 'test', num_results: Number.NaN }), false);
    assert.equal(isSearXNGWebSearchArgs({ query: 'test', num_results: '3' }), false);
  }, results);

  await testFunction('WEB_SEARCH_TOOL schema includes week, min_score, and num_results', () => {
    const properties = WEB_SEARCH_TOOL.inputSchema.properties as Record<string, any>;
    assert.ok(properties.time_range.enum.includes('week'));
    assert.equal(properties.safesearch.type, 'string');
    assert.deepEqual(properties.safesearch.enum, ['0', '1', '2']);
    assert.equal(properties.safesearch.default, '0');
    assert.ok(!properties.safesearch.enum.some((value: unknown) => typeof value === 'number'));
    assert.equal(properties.min_score.type, 'number');
    assert.equal(properties.min_score.minimum, 0);
    assert.equal(properties.min_score.maximum, 1);
    assert.equal(properties.num_results.type, 'number');
    assert.equal(properties.num_results.minimum, 1);
    assert.equal(properties.num_results.maximum, 20);
  }, results);

  await testFunction('isWebUrlReadArgs type guard - basic valid cases', () => {
    assert.equal(isWebUrlReadArgs({ url: 'https://example.com' }), true);
    assert.equal(isWebUrlReadArgs({ url: 'http://test.com' }), true);
  }, results);

  await testFunction('isWebUrlReadArgs type guard - with pagination parameters', () => {
    assert.equal(isWebUrlReadArgs({ url: 'https://example.com', startChar: 0 }), true);
    assert.equal(isWebUrlReadArgs({ url: 'https://example.com', maxLength: 100 }), true);
    assert.equal(isWebUrlReadArgs({ url: 'https://example.com', section: 'intro' }), true);
    assert.equal(isWebUrlReadArgs({ url: 'https://example.com', paragraphRange: '1-5' }), true);
    assert.equal(isWebUrlReadArgs({ url: 'https://example.com', readHeadings: true }), true);
  }, results);

  await testFunction('isWebUrlReadArgs type guard - with all parameters', () => {
    assert.equal(isWebUrlReadArgs({
      url: 'https://example.com',
      startChar: 10,
      maxLength: 200,
      section: 'section1',
      paragraphRange: '2-4',
      readHeadings: false
    }), true);
  }, results);

  await testFunction('isWebUrlReadArgs type guard - invalid cases', () => {
    assert.equal(isWebUrlReadArgs({ notUrl: 'invalid' }), false);
    assert.equal(isWebUrlReadArgs(null), false);
    assert.equal(isWebUrlReadArgs(undefined), false);
    assert.equal(isWebUrlReadArgs('string'), false);
    assert.equal(isWebUrlReadArgs(123), false);
    assert.equal(isWebUrlReadArgs({}), false);
  }, results);

  await testFunction('isWebUrlReadArgs type guard - invalid parameter types', () => {
    assert.equal(isWebUrlReadArgs({ url: 'https://example.com', startChar: -1 }), false);
    assert.equal(isWebUrlReadArgs({ url: 'https://example.com', maxLength: 0 }), false);
    assert.equal(isWebUrlReadArgs({ url: 'https://example.com', startChar: 'invalid' }), false);
    assert.equal(isWebUrlReadArgs({ url: 'https://example.com', maxLength: 'invalid' }), false);
    assert.equal(isWebUrlReadArgs({ url: 'https://example.com', section: 123 }), false);
    assert.equal(isWebUrlReadArgs({ url: 'https://example.com', paragraphRange: 123 }), false);
    assert.equal(isWebUrlReadArgs({ url: 'https://example.com', readHeadings: 'invalid' }), false);
  }, results);

  // BUG-002: SearXNGWeb expanded interface tests

  await testFunction('SearXNGWeb - full response with all optional fields', () => {
    const infobox: SearXNGWebInfobox = {
      infobox: 'TypeScript',
      content: 'A typed superset of JavaScript',
      urls: [{ title: 'Official site', url: 'https://www.typescriptlang.org' }],
    };
    const mockResponse: SearXNGWeb = {
      query: 'typescript',
      number_of_results: 1,
      results: [
        {
          title: 'TypeScript',
          content: 'Typed JavaScript at any scale.',
          url: 'https://www.typescriptlang.org',
          score: 0.95,
          engine: 'google',
          engines: ['google', 'bing'],
          category: 'general',
          publishedDate: '2024-01-01',
          thumbnail: 'https://example.com/thumb.jpg',
          img_src: 'https://example.com/img.jpg',
        },
      ],
      suggestions: ['typescript tutorial', 'typescript vs javascript'],
      corrections: [],
      answers: ['TypeScript is a typed superset of JavaScript.'],
      infoboxes: [infobox],
      unresponsive_engines: [['duckduckgo', 'timeout']],
    };
    assert.equal(mockResponse.query, 'typescript');
    assert.equal(mockResponse.number_of_results, 1);
    assert.equal(mockResponse.results.length, 1);
    assert.equal(mockResponse.results[0].engine, 'google');
    assert.deepEqual(mockResponse.results[0].engines, ['google', 'bing']);
    assert.equal(mockResponse.results[0].category, 'general');
    assert.equal(mockResponse.results[0].publishedDate, '2024-01-01');
    assert.equal(mockResponse.results[0].thumbnail, 'https://example.com/thumb.jpg');
    assert.equal(mockResponse.results[0].img_src, 'https://example.com/img.jpg');
    assert.deepEqual(mockResponse.suggestions, ['typescript tutorial', 'typescript vs javascript']);
    assert.deepEqual(mockResponse.answers, ['TypeScript is a typed superset of JavaScript.']);
    assert.equal(mockResponse.infoboxes![0].infobox, 'TypeScript');
    assert.equal(mockResponse.infoboxes![0].urls![0].title, 'Official site');
    assert.deepEqual(mockResponse.unresponsive_engines, [['duckduckgo', 'timeout']]);
  }, results);

  await testFunction('SearXNGWeb - minimal response with required fields only', () => {
    const mockResponse: SearXNGWeb = {
      query: 'hello world',
      number_of_results: 0,
      results: [],
    };
    assert.equal(mockResponse.query, 'hello world');
    assert.equal(mockResponse.number_of_results, 0);
    assert.deepEqual(mockResponse.results, []);
    assert.equal(mockResponse.suggestions, undefined);
    assert.equal(mockResponse.corrections, undefined);
    assert.equal(mockResponse.answers, undefined);
    assert.equal(mockResponse.infoboxes, undefined);
    assert.equal(mockResponse.unresponsive_engines, undefined);
  }, results);

  await testFunction('SearXNGWebResult - required and optional fields', () => {
    const minimalResult: SearXNGWebResult = {
      title: 'Example',
      content: 'Some content',
      url: 'https://example.com',
      score: 0.8,
    };
    assert.equal(minimalResult.title, 'Example');
    assert.equal(minimalResult.score, 0.8);
    assert.equal(minimalResult.engine, undefined);
    assert.equal(minimalResult.engines, undefined);
    assert.equal(minimalResult.category, undefined);
    assert.equal(minimalResult.publishedDate, undefined);
    assert.equal(minimalResult.thumbnail, undefined);
    assert.equal(minimalResult.img_src, undefined);
  }, results);

  await testFunction('SearXNGWebInfobox - required and optional fields', () => {
    const minimalInfobox: SearXNGWebInfobox = { infobox: 'JavaScript' };
    assert.equal(minimalInfobox.infobox, 'JavaScript');
    assert.equal(minimalInfobox.content, undefined);
    assert.equal(minimalInfobox.urls, undefined);

    const fullInfobox: SearXNGWebInfobox = {
      infobox: 'Node.js',
      content: 'JavaScript runtime',
      urls: [
        { title: 'nodejs.org', url: 'https://nodejs.org' },
        { title: 'docs', url: 'https://nodejs.org/docs' },
      ],
    };
    assert.equal(fullInfobox.infobox, 'Node.js');
    assert.equal(fullInfobox.urls!.length, 2);
    assert.equal(fullInfobox.urls![1].title, 'docs');
  }, results);

  await testFunction('isSearXNGWebSearchArgs accepts categories string', () => {
    assert.equal(isSearXNGWebSearchArgs({ query: 'test', categories: 'news' }), true);
    assert.equal(isSearXNGWebSearchArgs({ query: 'test', categories: 'it,science' }), true);
    assert.equal(isSearXNGWebSearchArgs({ query: 'test', categories: 'general' }), true);
  }, results);

  await testFunction('isSearXNGWebSearchArgs accepts response_format text or json', () => {
    assert.equal(isSearXNGWebSearchArgs({ query: 'test', response_format: 'text' }), true);
    assert.equal(isSearXNGWebSearchArgs({ query: 'test', response_format: 'json' }), true);
  }, results);

  await testFunction('isSearXNGWebSearchArgs rejects non-string categories', () => {
    assert.equal(isSearXNGWebSearchArgs({ query: 'test', categories: 123 }), false);
    assert.equal(isSearXNGWebSearchArgs({ query: 'test', categories: ['news'] }), false);
  }, results);

  await testFunction('isSearXNGWebSearchArgs rejects non-string engines', () => {
    assert.equal(isSearXNGWebSearchArgs({ query: 'test', engines: 123 }), false);
    assert.equal(isSearXNGWebSearchArgs({ query: 'test', engines: ['google'] }), false);
  }, results);

  await testFunction('isSearXNGWebSearchArgs rejects invalid response_format', () => {
    assert.equal(isSearXNGWebSearchArgs({ query: 'test', response_format: 'xml' }), false);
    assert.equal(isSearXNGWebSearchArgs({ query: 'test', response_format: 123 }), false);
  }, results);

  await testFunction('WEB_SEARCH_TOOL schema includes categories property', () => {
    const properties = WEB_SEARCH_TOOL.inputSchema.properties as Record<string, any>;
    assert.ok(properties.categories, 'WEB_SEARCH_TOOL must expose categories parameter');
    assert.equal(properties.categories.type, 'string');
    assert.ok(properties.categories.description.includes('case-insensitively'), properties.categories.description);
    assert.ok(properties.categories.description.includes('/config'), properties.categories.description);
  }, results);

  await testFunction('WEB_SEARCH_TOOL schema includes engines property', () => {
    const properties = WEB_SEARCH_TOOL.inputSchema.properties as Record<string, any>;
    assert.ok(properties.engines, 'WEB_SEARCH_TOOL must expose engines parameter');
    assert.equal(properties.engines.type, 'string');
    assert.ok(properties.engines.description.includes('case-insensitively'), properties.engines.description);
    assert.ok(!properties.engines.description.includes('matched exactly'), properties.engines.description);
  }, results);

  await testFunction('WEB_SEARCH_TOOL schema includes response_format enum', () => {
    const properties = WEB_SEARCH_TOOL.inputSchema.properties as Record<string, any>;
    assert.ok(properties.response_format, 'WEB_SEARCH_TOOL must expose response_format parameter');
    assert.equal(properties.response_format.type, 'string');
    assert.deepEqual(properties.response_format.enum, ['text', 'json']);
  }, results);

  await testFunction('LITE_WEB_SEARCH_TOOL schema has only query property', () => {
    const props = LITE_WEB_SEARCH_TOOL.inputSchema.properties as Record<string, any>;
    assert.ok(props.query, 'LITE_WEB_SEARCH_TOOL must have query property');
    assert.equal(Object.keys(props).length, 1, 'LITE_WEB_SEARCH_TOOL must have exactly one property');
    assert.deepEqual(LITE_WEB_SEARCH_TOOL.inputSchema.required, ['query']);
    assert.equal(LITE_WEB_SEARCH_TOOL.name, 'searxng_web_search');
  }, results);

  await testFunction('LITE_READ_URL_TOOL schema has only url property', () => {
    const props = LITE_READ_URL_TOOL.inputSchema.properties as Record<string, any>;
    assert.ok(props.url, 'LITE_READ_URL_TOOL must have url property');
    assert.equal(Object.keys(props).length, 1, 'LITE_READ_URL_TOOL must have exactly one property');
    assert.deepEqual(LITE_READ_URL_TOOL.inputSchema.required, ['url']);
    assert.equal(LITE_READ_URL_TOOL.name, 'web_url_read');
  }, results);

  await testFunction('Full WEB_SEARCH_TOOL schema has multiple properties including language', () => {
    const props = WEB_SEARCH_TOOL.inputSchema.properties as Record<string, any>;
    assert.ok(props.query);
    assert.ok(props.language, 'Full tool must expose language parameter');
    assert.ok(props.safesearch, 'Full tool must expose safesearch parameter');
    assert.ok(props.num_results, 'Full tool must expose num_results parameter');
    assert.ok(Object.keys(props).length > 1, 'Full tool must have more than one property');
  }, results);

  await testFunction('Full READ_URL_TOOL schema has multiple properties', () => {
    const props = READ_URL_TOOL.inputSchema.properties as Record<string, any>;
    assert.ok(props.url);
    assert.ok(props.maxLength, 'Full tool must expose maxLength parameter');
    assert.ok(Object.keys(props).length > 1, 'Full tool must have more than one property');
  }, results);

  await testFunction('isSearXNGSearchSuggestionsArgs accepts query and optional language', () => {
    assert.equal(isSearXNGSearchSuggestionsArgs({ query: 'type' }), true);
    assert.equal(isSearXNGSearchSuggestionsArgs({ query: 'type', language: 'fr' }), true);
  }, results);

  await testFunction('isSearXNGSearchSuggestionsArgs rejects invalid arguments', () => {
    assert.equal(isSearXNGSearchSuggestionsArgs({}), false);
    assert.equal(isSearXNGSearchSuggestionsArgs({ query: 123 }), false);
    assert.equal(isSearXNGSearchSuggestionsArgs({ query: 'type', language: 123 }), false);
    assert.equal(isSearXNGSearchSuggestionsArgs(null), false);
  }, results);

  await testFunction('SUGGESTIONS_TOOL schema exposes query and language', () => {
    const props = SUGGESTIONS_TOOL.inputSchema.properties as Record<string, any>;
    assert.equal(SUGGESTIONS_TOOL.name, 'searxng_search_suggestions');
    assert.ok(props.query, 'SUGGESTIONS_TOOL must have query property');
    assert.ok(props.language, 'SUGGESTIONS_TOOL must have language property');
    assert.deepEqual(SUGGESTIONS_TOOL.inputSchema.required, ['query']);
  }, results);

  await testFunction('LITE_SUGGESTIONS_TOOL schema has only query property', () => {
    const props = LITE_SUGGESTIONS_TOOL.inputSchema.properties as Record<string, any>;
    assert.equal(LITE_SUGGESTIONS_TOOL.name, 'searxng_search_suggestions');
    assert.ok(props.query, 'LITE_SUGGESTIONS_TOOL must have query property');
    assert.equal(Object.keys(props).length, 1, 'LITE_SUGGESTIONS_TOOL must have exactly one property');
    assert.deepEqual(LITE_SUGGESTIONS_TOOL.inputSchema.required, ['query']);
  }, results);

  await testFunction('isSearXNGInstanceInfoArgs accepts optional controls', () => {
    assert.equal(isSearXNGInstanceInfoArgs({}), true);
    assert.equal(isSearXNGInstanceInfoArgs({ includeEngines: true }), true);
    assert.equal(isSearXNGInstanceInfoArgs({ includeDisabled: true, category: 'news', refresh: true }), true);
  }, results);

  await testFunction('isSearXNGInstanceInfoArgs rejects invalid controls', () => {
    assert.equal(isSearXNGInstanceInfoArgs(null), false);
    assert.equal(isSearXNGInstanceInfoArgs({ includeEngines: 'yes' }), false);
    assert.equal(isSearXNGInstanceInfoArgs({ includeDisabled: 'no' }), false);
    assert.equal(isSearXNGInstanceInfoArgs({ category: 123 }), false);
    assert.equal(isSearXNGInstanceInfoArgs({ refresh: 'true' }), false);
  }, results);

  await testFunction('INSTANCE_INFO_TOOL schema exposes capability controls', () => {
    const props = INSTANCE_INFO_TOOL.inputSchema.properties as Record<string, any>;
    assert.equal(INSTANCE_INFO_TOOL.name, 'searxng_instance_info');
    assert.ok(props.includeEngines);
    assert.ok(props.includeDisabled);
    assert.ok(props.category);
    assert.ok(props.refresh);
    assert.deepEqual(INSTANCE_INFO_TOOL.inputSchema.required, []);
  }, results);

  await testFunction('LITE_INSTANCE_INFO_TOOL schema has no optional controls', () => {
    const props = LITE_INSTANCE_INFO_TOOL.inputSchema.properties as Record<string, any>;
    assert.equal(LITE_INSTANCE_INFO_TOOL.name, 'searxng_instance_info');
    assert.equal(Object.keys(props).length, 0);
    assert.deepEqual(LITE_INSTANCE_INFO_TOOL.inputSchema.required, []);
  }, results);

  printTestSummary(results, 'Types Module');
  return results;
}

// Run if executed directly
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  runTests().then(results => {
    process.exit(results.failed > 0 ? 1 : 0);
  }).catch(console.error);
}

export { runTests };
