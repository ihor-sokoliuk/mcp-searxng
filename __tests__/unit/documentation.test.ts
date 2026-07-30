#!/usr/bin/env tsx

/**
 * Unit Tests: client configuration cookbook
 *
 * Keeps copyable client examples aligned with the current server contract.
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createTestResults, printTestSummary, TestResult, testFunction } from '../helpers/test-utils.js';

const results = createTestResults();
const guideUrl = new URL('../../docs/client-configurations.md', import.meta.url);
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
  console.log('Testing: client configuration cookbook\n');

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

  printTestSummary(results, 'Client Configuration Cookbook');
  return results;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  runTests();
}
