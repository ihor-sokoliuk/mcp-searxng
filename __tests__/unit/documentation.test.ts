#!/usr/bin/env tsx

/**
 * Unit Tests: public documentation guides
 *
 * Keeps public guidance aligned with the current server contract.
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createTestResults, printTestSummary, TestResult, testFunction } from '../helpers/test-utils.js';

const results = createTestResults();
const guideUrl = new URL('../../docs/client-configurations.md', import.meta.url);
const researchGuideUrl = new URL('../../docs/research-workflow.md', import.meta.url);
const deploymentGuideUrl = new URL('../../docs/deployment-profiles.md', import.meta.url);
const resourceOverlayUrl = new URL('../../docker-compose.resources.yml', import.meta.url);
const markdownFence = String.fromCharCode(96).repeat(3);

const expectedMatrixRows = [
  '| Claude Desktop | Yes | Yes | No |',
  '| Claude Code | Yes | Yes | Yes |',
  '| Codex CLI | Yes | Yes | Yes |',
  '| Cursor | Yes | Yes | No |',
  '| VS Code | Yes | Yes | Yes |',
  '| Windsurf | Yes | Yes | Yes |',
  '| Cline | Yes | Yes | Yes |',
  '| OpenCode | Yes | Yes | Yes |',
];

const expectedTools = [
  'searxng_web_search',
  'searxng_search_suggestions',
  'searxng_instance_info',
  'web_url_read',
];

function readText(url: URL): string {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- all callers pass compile-time repository URLs
  return readFileSync(url, 'utf-8');
}

function extractFences(markdown: string, language: string): string[] {
  const blocks: string[] = [];
  let active: string[] | null = null;

  for (const line of markdown.split(/\r?\n/u)) {
    if (active === null && line.trim() === markdownFence + language) {
      active = [];
    } else if (active !== null && line.trim() === markdownFence) {
      blocks.push(active.join('\n'));
      active = null;
    } else if (active !== null) {
      active.push(line);
    }
  }

  assert.equal(active, null, `unclosed ${language} fence`);
  return blocks;
}

function parseTomlSubset(source: string): void {
  let hasSection = false;
  const allowedNameCharacters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.-';

  for (const rawLine of source.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    if (line.startsWith('[') && line.endsWith(']')) {
      const name = line.slice(1, -1);
      assert.ok(name.length > 0);
      assert.ok([...name].every((character) => allowedNameCharacters.includes(character)));
      hasSection = true;
      continue;
    }

    const separator = line.indexOf('=');
    assert.ok(separator > 0, `missing TOML assignment: ${line}`);
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    assert.ok([...key].every((character) => allowedNameCharacters.includes(character)));
    const parsed = JSON.parse(value);
    assert.ok(typeof parsed === 'string' || (
      Array.isArray(parsed) && parsed.every((entry) => typeof entry === 'string')
    ), `unsupported TOML value: ${value}`);
  }

  assert.ok(hasSection, 'each TOML example must contain a table');
}

function collectJsonServers(config: Record<string, unknown>): Record<string, unknown>[] {
  const roots = [
    config.mcpServers,
    config.servers,
    (config.mcp as Record<string, unknown> | undefined)?.servers,
  ];

  return roots.flatMap((root) => (
    root && typeof root === 'object'
      ? Object.values(root as Record<string, unknown>)
          .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
      : []
  ));
}

export async function runTests(): Promise<TestResult> {
  console.log('Testing: public documentation guides\n');

  await testFunction('cookbook exists and README links to it', () => {
    const guide = readText(guideUrl);
    const readme = readText(new URL('../../README.md', import.meta.url));
    assert.ok(guide.startsWith('# MCP Client Configuration Cookbook'));
    assert.ok(readme.includes('(docs/client-configurations.md)'));
  }, results);

  await testFunction('support matrix contains only verified client and transport combinations', () => {
    const guide = readText(guideUrl);
    for (const row of expectedMatrixRows) {
      assert.ok(guide.includes(row), `missing matrix row: ${row}`);
    }
    assert.equal((guide.match(/^\| (?:Claude Desktop|Claude Code|Codex CLI|Cursor|VS Code|Windsurf|Cline|OpenCode) \|/gmu) ?? []).length, 8);
  }, results);

  await testFunction('every JSON and TOML configuration snippet parses', () => {
    const guide = readText(guideUrl);
    const jsonBlocks = extractFences(guide, 'json');
    const tomlBlocks = extractFences(guide, 'toml');
    assert.ok(jsonBlocks.length >= 6, 'expected client JSON examples');
    assert.ok(tomlBlocks.length >= 2, 'expected Codex TOML examples');
    for (const block of jsonBlocks) JSON.parse(block);
    for (const block of tomlBlocks) parseTomlSubset(block);
  }, results);

  await testFunction('local examples use current NPX and Docker launch contracts', () => {
    const guide = readText(guideUrl);
    const servers = extractFences(guide, 'json')
      .flatMap((block) => collectJsonServers(JSON.parse(block) as Record<string, unknown>));

    const localServers = servers.filter((server) => (
      typeof server.command === 'string' || Array.isArray(server.command)
    ));
    assert.ok(localServers.some((server) => server.command === 'npx'));
    assert.ok(localServers.some((server) => server.command === 'docker'));
    assert.ok(localServers.some((server) => Array.isArray(server.command) && server.command[0] === 'npx'));
    assert.ok(localServers.some((server) => Array.isArray(server.command) && server.command[0] === 'docker'));

    for (const server of localServers) {
      const command = Array.isArray(server.command)
        ? server.command
        : [server.command, ...(server.args as unknown[])];
      if (command[0] === 'npx') {
        assert.deepEqual(command, ['npx', '-y', 'mcp-searxng']);
      } else if (command[0] === 'docker') {
        assert.deepEqual(command, [
          'docker',
          'run', '-i', '--rm',
          '-e', 'SEARXNG_URL',
          'isokoliuk/mcp-searxng:latest',
        ]);
      }
    }

    assert.ok(guide.includes('SEARXNG_URL'));
  }, results);

  await testFunction('remote examples use the current endpoint and bearer header contract', () => {
    const guide = readText(guideUrl);
    const servers = extractFences(guide, 'json')
      .flatMap((block) => collectJsonServers(JSON.parse(block) as Record<string, unknown>));
    const remoteServers = servers.filter((server) => typeof server.url === 'string' || typeof server.serverUrl === 'string');
    assert.ok(remoteServers.length >= 4, 'expected verified HTTP client examples');
    for (const server of remoteServers) {
      const url = String(server.url ?? server.serverUrl);
      assert.ok(url.endsWith('/mcp'), `remote MCP URL must end in /mcp: ${url}`);
      const headers = server.headers as Record<string, unknown> | undefined;
      assert.ok(headers?.Authorization, 'authenticated remote examples must show Authorization handling');
    }
    assert.ok(guide.includes('MCP_HTTP_AUTH_TOKEN'));
    assert.ok(guide.includes('MCP_HTTP_ALLOWED_ORIGINS'));
    assert.ok(guide.includes('MCP_HTTP_ALLOWED_HOSTS'));
  }, results);

  await testFunction('verification checklist names all current tools', () => {
    const guide = readText(guideUrl);
    const types = readText(new URL('../../src/types.ts', import.meta.url));
    for (const tool of expectedTools) {
      assert.ok(guide.includes(`\`${tool}\``), `guide must name ${tool}`);
      assert.ok(types.includes(`name: "${tool}"`), `source must still expose ${tool}`);
    }
  }, results);

  await testFunction('research workflow exists and README links to it', () => {
    const guide = readText(researchGuideUrl);
    const readme = readText(new URL('../../README.md', import.meta.url));
    assert.ok(guide.startsWith('# Evidence-Focused Research Workflow'));
    assert.ok(readme.includes('(docs/research-workflow.md)'));
  }, results);

  await testFunction('research workflow uses current full schemas and describes Lite Tools limits', () => {
    const guide = readText(researchGuideUrl);
    const normalizedGuide = guide.replace(/\s+/gu, ' ');
    const types = readText(new URL('../../src/types.ts', import.meta.url));
    const fullSchemaParameters = [
      'query', 'pageno', 'time_range', 'language', 'safesearch', 'min_score',
      'num_results', 'categories', 'engines', 'response_format',
      'includeEngines', 'includeDisabled', 'category', 'refresh',
      'url', 'startChar', 'maxLength', 'section', 'paragraphRange', 'readHeadings',
    ];

    for (const tool of expectedTools) {
      assert.ok(guide.includes(`\`${tool}\``), `workflow must name ${tool}`);
      assert.ok(types.includes(`name: "${tool}"`), `source must still expose ${tool}`);
    }
    for (const parameter of fullSchemaParameters) {
      assert.ok(guide.includes(`\`${parameter}\``), `workflow must describe ${parameter}`);
      assert.ok(types.includes(`${parameter}: {`), `full schemas must still expose ${parameter}`);
    }
    assert.ok(guide.includes('`SEARXNG_LITE_TOOLS=true`'));
    assert.ok(normalizedGuide.includes('search and suggestions accept only `query`'));
    assert.ok(normalizedGuide.includes('instance information accepts no optional controls'));
    assert.ok(normalizedGuide.includes('URL reading accepts only `url`'));
  }, results);

  await testFunction('research workflow is bounded and evidence focused', () => {
    const guide = readText(researchGuideUrl);
    for (const phrase of [
      'Stopping conditions',
      'Cross-check material claims',
      'Cite the evidence',
      'State uncertainty',
      'Evidence versus inference',
      'adjustable starting point',
      '(self-hosted-searxng.md)',
      '(public-searxng-instances.md)',
    ]) {
      assert.ok(guide.includes(phrase), `workflow must include: ${phrase}`);
    }
    for (const unsupportedPromise of [
      'guarantees results',
      'all engines are available',
      'automatically private',
    ]) {
      assert.ok(!guide.includes(unsupportedPromise), `workflow must not promise: ${unsupportedPromise}`);
    }
  }, results);

  await testFunction('deployment profiles exist and public navigation links to them', () => {
    const guide = readText(deploymentGuideUrl);
    const readme = readText(new URL('../../README.md', import.meta.url));
    const configuration = readText(new URL('../../CONFIGURATION.md', import.meta.url));
    const compose = readText(new URL('../../docker-compose.yml', import.meta.url));
    assert.ok(guide.startsWith('# Measured MCP Deployment Profiles'));
    assert.ok(readme.includes('(docs/deployment-profiles.md)'));
    assert.ok(configuration.includes('(docs/deployment-profiles.md)'));
    assert.ok(compose.includes('docs/deployment-profiles.md'));
  }, results);

  await testFunction('deployment measurements are traceable and recommendations remain bounded', () => {
    const guide = readText(deploymentGuideUrl);
    const normalizedGuide = guide.replace(/\s+/gu, ' ');
    for (const evidence of [
      '2026-07-29',
      'Node 24.18.0',
      'Docker Engine 29.6.2',
      'linux/amd64',
      'ecd0b7c99941d8e204d633676873058b2a07fffe',
      '| Small | 1 | 160 | 6.03 s | 52.39-110.60 MiB | 8.72% | 11.39% |',
      '| Balanced | 4 | 480 | 6.06 s | 53.43-139.30 MiB | 20.39% | 31.84% |',
      '| Research-heavy | 8 | 960 | 6.06 s | 53.63-254.40 MiB | 40.80% | 65.32% |',
      'starting range, not a universal requirement',
      'does not size SearXNG',
    ]) {
      assert.ok(normalizedGuide.includes(evidence), `missing deployment evidence: ${evidence}`);
    }
  }, results);

  await testFunction('deployment profiles use current configuration and valid MCP-only Compose fields', () => {
    const guide = readText(deploymentGuideUrl);
    const configuration = readText(new URL('../../CONFIGURATION.md', import.meta.url));
    const overlay = readText(resourceOverlayUrl);
    const variables = [
      'SEARXNG_MAX_RESULTS',
      'FETCH_TIMEOUT_MS',
      'SEARCH_CACHE_TTL_MS',
      'SEARCH_CACHE_MAX_ENTRIES',
      'URL_READ_MAX_CHARS',
      'URL_READ_MAX_CONTENT_LENGTH_BYTES',
      'CACHE_TTL_MS',
      'CACHE_MAX_ENTRIES',
      'SEARXNG_FANOUT',
      'MCP_RATE_WINDOW_MS',
      'MCP_RATE_INIT_MAX',
      'MCP_RATE_SESSION_MAX',
    ];
    for (const variable of variables) {
      assert.ok(guide.includes(`\`${variable}\``), `guide must name ${variable}`);
      assert.ok(configuration.includes(`\`${variable}\``), `configuration must still define ${variable}`);
    }
    assert.ok(overlay.includes('cpus: ${MCP_SEARXNG_CPUS:-0.50}'));
    assert.ok(overlay.includes('mem_limit: ${MCP_SEARXNG_MEMORY_LIMIT:-256m}'));
    assert.ok(overlay.includes('mem_reservation: ${MCP_SEARXNG_MEMORY_RESERVATION:-192m}'));
    assert.ok(!overlay.includes('\n  searxng:'), 'resource overlay must not add or size SearXNG');
  }, results);

  printTestSummary(results, 'Public Documentation Guides');
  return results;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  runTests().then((testResults) => {
    process.exit(testResults.failed > 0 ? 1 : 0);
  }).catch(console.error);
}
