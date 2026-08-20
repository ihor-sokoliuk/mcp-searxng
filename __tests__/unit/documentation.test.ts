#!/usr/bin/env tsx

/**
 * Unit Tests: public documentation guides
 *
 * Keeps public guidance aligned with the current server contract.
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  MAX_CONCURRENT_PDF_WORKERS,
  MAX_PDF_BYTES,
  MAX_PDF_PAGES,
  PDF_PARSE_TIMEOUT_MS,
  PDF_WORKER_RESOURCE_LIMITS,
} from '../../src/pdf-reader.js';
import {
  DEFAULT_BYPARR_CONCURRENCY,
  DEFAULT_BYPARR_TIMEOUT_SECONDS,
  DEFAULT_FLARESOLVERR_CONCURRENCY,
  DEFAULT_FLARESOLVERR_TIMEOUT_MS,
  MAX_BYPARR_CONCURRENCY,
  MAX_BYPARR_TIMEOUT_SECONDS,
  MAX_FLARESOLVERR_CONCURRENCY,
  MAX_FLARESOLVERR_TIMEOUT_MS,
} from '../../src/browser-solver.js';
import { LITE_READ_URL_TOOL, READ_URL_TOOL } from '../../src/types.js';
import {
  DEFAULT_STATELESS_MAX_IN_FLIGHT,
  DEFAULT_STATELESS_MAX_IN_FLIGHT_PER_IP,
  DEFAULT_STATELESS_REQUEST_TIMEOUT_MS,
  MAX_STATELESS_MAX_IN_FLIGHT,
} from '../../src/http-server.js';
import { createTestResults, printTestSummary, TestResult, testFunction } from '../helpers/test-utils.js';

const results = createTestResults();
const guideUrl = new URL('../../docs/client-configurations.md', import.meta.url);
const researchGuideUrl = new URL('../../docs/research-workflow.md', import.meta.url);
const deploymentGuideUrl = new URL('../../docs/deployment-profiles.md', import.meta.url);
const baseComposeUrl = new URL('../../docker-compose.yml', import.meta.url);
const resourceOverlayUrl = new URL('../../docker-compose.resources.yml', import.meta.url);
const httpOverlayUrl = new URL('../../docker-compose.http.yml', import.meta.url);
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

function hasDependabotIgnoreEntry(source: string, dependencyName: string): boolean {
  let updateIndentation = -1;
  let ignoreIndentation = -1;

  for (const rawLine of source.split(/\r?\n/u)) {
    const lineWithoutComment = rawLine.replace(/\s+#.*$/u, '');
    const line = lineWithoutComment.trim();
    if (line === '') continue;

    const indentation = rawLine.length - rawLine.trimStart().length;
    if (/^-\s+package-ecosystem\s*:/u.test(line)) {
      updateIndentation = indentation;
      ignoreIndentation = -1;
      continue;
    }
    if (updateIndentation === -1) continue;
    if (indentation <= updateIndentation && /^-\s+/u.test(line)) {
      updateIndentation = -1;
      ignoreIndentation = -1;
      continue;
    }
    if (ignoreIndentation !== -1 && indentation <= ignoreIndentation) {
      ignoreIndentation = -1;
    }
    if (indentation > updateIndentation && /^ignore\s*:\s*$/u.test(line)) {
      ignoreIndentation = indentation;
      continue;
    }
    if (ignoreIndentation === -1 || indentation <= ignoreIndentation) continue;

    const match = line.match(/^-\s*dependency-name\s*:\s*(.+?)\s*$/u);
    if (match === null) continue;
    const value = match[1].trim();
    const unquotedValue = (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
      ? value.slice(1, -1)
      : value;
    if (unquotedValue === dependencyName) return true;
  }

  return false;
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

  await testFunction('README documents bounded PDF text extraction and its limits', () => {
    const readme = readText(new URL('../../README.md', import.meta.url));
    const maxPdfMiB = MAX_PDF_BYTES / (1024 * 1024);
    const parseTimeoutSeconds = PDF_PARSE_TIMEOUT_MS / 1000;
    assert.equal(MAX_CONCURRENT_PDF_WORKERS, 2);
    for (const statement of [
      'PDF (`application/pdf`) text is extracted',
      `${maxPdfMiB} MiB`,
      `${MAX_PDF_PAGES} pages`,
      `${parseTimeoutSeconds}-second`,
      'At most two PDF extractions run concurrently per MCP process',
      'OCR is not supported',
      'password-protected',
    ]) {
      assert.ok(readme.includes(statement), `README must document: ${statement}`);
    }
  }, results);

  await testFunction('public solver documentation states the verified provider boundary', () => {
    const readme = readText(new URL('../../README.md', import.meta.url));
    const configuration = readText(new URL('../../CONFIGURATION.md', import.meta.url));
    const security = readText(new URL('../../SECURITY.md', import.meta.url));

    for (const document of [readme, configuration, security]) {
      assert.ok(document.includes('FlareSolverr 3.5.0'));
      assert.ok(document.includes('Byparr 2.1.0'));
      assert.ok(document.includes('2026-07-30'));
      assert.ok(document.includes(
        'sha256:139dfee1c6f89249c8d665d1333a42e8ec74ec0a86bc6bb1c8461e10d3a66a47',
      ));
      assert.ok(document.includes(
        'sha256:01a46a2865d9a6db5eb8ead04ec0dd33b8fbe233e8565ae70b50d4cc0af4cfb0',
      ));
      assert.ok(document.includes('linux/amd64'));
      assert.ok(document.includes('remote browser may'));
      assert.ok(document.includes('HTTP client'));
      assert.ok(document.includes('disconnects'));
    }
    for (const document of [readme, configuration]) {
      const normalized = document.replace(/\s+/gu, ' ');
      assert.ok(normalized.includes('FlareSolverr is always primary'));
      assert.ok(normalized.includes('150 seconds'));
      assert.ok(normalized.includes('unavailable'));
    }
    const normalizedSecurity = security.replace(/\s+/gu, ' ');
    assert.ok(normalizedSecurity.includes('FlareSolverr as the fixed primary'));
    assert.ok(normalizedSecurity.includes('150 seconds'));
    assert.ok(normalizedSecurity.includes('unavailable'));
    assert.ok(readme.includes('no automatic reverse failover'));
    assert.ok(configuration.includes('automatic reverse failover is not performed'));
    assert.ok(security.includes('does not retain a health score'));
    for (const contract of [
      `\`FLARESOLVERR_TIMEOUT_MS\` | No | \`${DEFAULT_FLARESOLVERR_TIMEOUT_MS}\``,
      `from \`1\` through \`${MAX_FLARESOLVERR_TIMEOUT_MS}\``,
      `\`FLARESOLVERR_MAX_CONCURRENT_REQUESTS\` | No | \`${DEFAULT_FLARESOLVERR_CONCURRENCY}\``,
      `from \`1\` through \`${MAX_FLARESOLVERR_CONCURRENCY}\``,
      `\`BYPARR_TIMEOUT_SECONDS\` | No | \`${DEFAULT_BYPARR_TIMEOUT_SECONDS}\``,
      `from \`1\` through \`${MAX_BYPARR_TIMEOUT_SECONDS}\``,
      `\`BYPARR_MAX_CONCURRENT_REQUESTS\` | No | \`${DEFAULT_BYPARR_CONCURRENCY}\``,
      `from \`1\` through \`${MAX_BYPARR_CONCURRENCY}\``,
    ]) {
      assert.ok(configuration.includes(contract), `configuration must include: ${contract}`);
    }

    for (const tool of [LITE_READ_URL_TOOL, READ_URL_TOOL]) {
      assert.ok(tool.description.includes('FlareSolverr first'));
      assert.ok(tool.description.includes('Byparr'));
      assert.ok(tool.description.includes('uncached direct'));
    }
  }, results);

  await testFunction('public PDF guidance matches the source-backed worker limits', () => {
    const configuration = readText(new URL('../../CONFIGURATION.md', import.meta.url));
    const security = readText(new URL('../../SECURITY.md', import.meta.url));
    const deployment = readText(deploymentGuideUrl);
    const maxPdfMiB = MAX_PDF_BYTES / (1024 * 1024);
    const parseTimeoutSeconds = PDF_PARSE_TIMEOUT_MS / 1000;
    const workerHeapMiB = PDF_WORKER_RESOURCE_LIMITS.maxOldGenerationSizeMb;
    const workerStackMiB = PDF_WORKER_RESOURCE_LIMITS.stackSizeMb;
    assert.equal(MAX_CONCURRENT_PDF_WORKERS, 2);

    for (const document of [configuration, security, deployment]) {
      assert.ok(document.includes(`${maxPdfMiB} MiB`));
      assert.ok(document.includes(`${MAX_PDF_PAGES} pages`));
      assert.ok(document.includes(`${parseTimeoutSeconds}-second`));
      assert.ok(document.includes(`${workerHeapMiB} MiB`));
      assert.ok(document.includes(`${workerStackMiB} MiB`));
      assert.ok(document.includes('two PDF extractions'));
    }
  }, results);

  await testFunction('README and public workflow metadata state the Node support policy', () => {
    const readme = readText(new URL('../../README.md', import.meta.url));
    const ci = readText(new URL('../../.github/workflows/ci.yml', import.meta.url));
    const codeql = readText(new URL('../../.github/workflows/codeql.yml', import.meta.url));
    const scorecard = readText(new URL('../../.github/workflows/scorecard.yml', import.meta.url));
    const dockerPublish = readText(new URL('../../.github/workflows/docker-publish.yml', import.meta.url));
    const dockerRebuild = readText(new URL('../../.github/workflows/docker-rebuild.yml', import.meta.url));
    const dependabot = readText(new URL('../../.github/dependabot.yml', import.meta.url));
    const packageManifest = JSON.parse(readText(new URL('../../package.json', import.meta.url))) as {
      dependencies?: Record<string, unknown>;
      engines?: Record<string, unknown>;
      version?: unknown;
    };

    assert.equal(packageManifest.version, '1.16.0');
    assert.equal(packageManifest.engines?.node, '>=20');
    assert.equal(packageManifest.dependencies?.['express-rate-limit'], '^8.5.2');

    assert.ok(readme.includes('Node.js 20 remains supported but is deprecated and end-of-life.'));
    assert.ok(readme.includes('Node.js 22 or later is recommended.'));
    assert.ok(readme.includes('Node.js 20 will be removed only in a future major release.'));

    const matrix = ci.match(/^\s*node-version:\s*\[([^\]]+)\]\s*$/mu);
    assert.ok(matrix, 'CI must declare an inline Node version matrix');
    assert.deepEqual(
      [...matrix[1].matchAll(/['"]([^'"]+)['"]/gu)].map((match) => match[1]),
      ['20', '22', '24', '26.7.0'],
    );
    const jobs = ci.slice(ci.indexOf('jobs:'));
    assert.deepEqual((jobs.match(/^  [A-Za-z0-9_-]+:\s*$/gmu) ?? []).map((line) => line.trim()), ['test:']);
    assert.match(ci, /uses:\s*actions\/checkout@/u);
    assert.match(ci, /uses:\s*actions\/setup-node@/u);
    assert.match(ci, /cache:\s*['"]npm['"]/u);
    for (const command of [
      /run:\s*npm ci/u,
      /run:\s*npm run lint/u,
      /run:\s*npm run build/u,
      /run:\s*npm run test:coverage/u,
    ]) {
      assert.match(ci, command);
    }
    assert.doesNotMatch(ci, /^\s*include\s*:/mu);
    assert.doesNotMatch(ci, /^\s*if\s*:/mu);
    assert.doesNotMatch(ci, /continue-on-error\s*:/u);

    const oldCodeqlSha = 'e4fba868fa4b1b91e1fdab776edc8cfbe6e9fb81';
    const newCodeqlSha = 'ff2f1c621b7f889edc0d3c761ac2e6a3f8cdb0dd';
    for (const workflow of [codeql, scorecard]) {
      assert.ok(!workflow.includes(oldCodeqlSha));
      const codeqlReferences = [
        ...workflow.matchAll(/uses:\s*github\/codeql-action\/[^@\s]+@([a-f0-9]{40})\s*#\s*(v[^\s]+)/gu),
      ];
      assert.ok(codeqlReferences.length > 0, 'workflow must retain CodeQL action references');
      for (const reference of codeqlReferences) {
        assert.equal(reference[1], newCodeqlSha);
        assert.equal(reference[2], 'v4.37.7');
      }
    }

    const oldDockerLoginSha = 'abd2ef45e78c5afb21d64d4ca52ee8550d9572c7';
    const newDockerLoginSha = 'dbcb813823bdd20940b903addbd779551569679f';
    for (const workflow of [dockerPublish, dockerRebuild]) {
      assert.ok(!workflow.includes(oldDockerLoginSha));
      const dockerLoginReferences = [
        ...workflow.matchAll(/uses:\s*docker\/login-action@([a-f0-9]{40})\s*#\s*(v[^\s]+)/gu),
      ];
      assert.equal(dockerLoginReferences.length, 1);
      assert.equal(dockerLoginReferences[0][1], newDockerLoginSha);
      assert.equal(dockerLoginReferences[0][2], 'v4.6.0');
    }

    const ignoredUnpdfFixture = `updates:
  - package-ecosystem: npm
    ignore:
      - dependency-name: "unpdf" # controlled ignored package
`;
    const allowedUnpdfFixture = `updates:
  - package-ecosystem: npm
    allow:
      - dependency-name: unpdf # controlled allowed package
`;
    assert.ok(hasDependabotIgnoreEntry(ignoredUnpdfFixture, 'unpdf'));
    assert.ok(!hasDependabotIgnoreEntry(allowedUnpdfFixture, 'unpdf'));
    assert.ok(!hasDependabotIgnoreEntry(dependabot, 'unpdf'));
  }, results);

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
      'num_results', 'categories', 'engines', 'response_format', 'result_detail',
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

  await testFunction('documentation explains compact result detail and the full-mode migration boundary', () => {
    const readme = readText(new URL('../../README.md', import.meta.url));
    const configuration = readText(new URL('../../CONFIGURATION.md', import.meta.url));
    const changelog = readText(new URL('../../CHANGELOG.md', import.meta.url));
    const guide = readText(researchGuideUrl);
    assert.ok(readme.includes('`result_detail`'));
    assert.ok(readme.includes('line parsers'));
    assert.ok(configuration.includes('compact and full'));
    assert.ok(changelog.includes('## Unreleased'));
    assert.ok(changelog.includes('result_detail'));
    assert.ok(guide.includes('`result_detail`'));
    assert.ok(readme.includes('Lite schema stays query-only'));
    assert.ok(readme.includes('explicitly supplied optional overrides'));
    assert.ok(guide.includes('Lite schema stays query-only'));
    assert.ok(configuration.includes('both compact and full text/JSON responses'));
    assert.ok(readme.includes('suppresses warnings, provenance, and every other search signal'));
    assert.ok(readme.includes('score, engines, category, published date, thumbnail, image source'));
    assert.ok(changelog.includes('full JSON content'));
    assert.ok(guide.includes('invalid optional metadata is omitted'));
    assert.ok(configuration.includes('normalizes line separators before applying the cap'));
    assert.ok(readme.includes('Text fields are normalized to single lines'));
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
    const baseCompose = readText(baseComposeUrl);
    const overlay = readText(resourceOverlayUrl);
    const variables = [
      'SEARXNG_MAX_RESULTS',
      'FETCH_TIMEOUT_MS',
      'FLARESOLVERR_TIMEOUT_MS',
      'FLARESOLVERR_MAX_CONCURRENT_REQUESTS',
      'BYPARR_TIMEOUT_SECONDS',
      'BYPARR_MAX_CONCURRENT_REQUESTS',
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
    assert.ok(!baseCompose.includes('ports:'), 'base Compose file must remain STDIO-only');
    assert.ok(!baseCompose.includes('MCP_HTTP_'), 'base Compose file must not select HTTP transport');
  }, results);

  await testFunction('deployment HTTP Compose profile is fail-closed and service-aware', () => {
    const guide = readText(deploymentGuideUrl);
    const normalizedGuide = guide.replace(/\s+/gu, ' ');
    const overlay = readText(httpOverlayUrl);
    for (const contract of [
      'MCP_HTTP_PORT=${MCP_HTTP_PORT:-3000}',
      'MCP_HTTP_HOST=0.0.0.0',
      'MCP_HTTP_HARDEN=true',
      'MCP_HTTP_AUTH_TOKEN=${MCP_HTTP_AUTH_TOKEN:?',
      'MCP_HTTP_ALLOWED_ORIGINS=${MCP_HTTP_ALLOWED_ORIGINS:?',
      'MCP_HTTP_ALLOWED_HOSTS',
      'MCP_HTTP_TRUST_PROXY',
      '${MCP_SEARXNG_HTTP_BIND_ADDRESS:-127.0.0.1}',
      '${MCP_SEARXNG_HTTP_PUBLISHED_PORT:-3000}',
    ]) {
      assert.ok(overlay.includes(contract), `HTTP overlay must include ${contract}`);
    }
    for (const composeFile of [
      'docker-compose.yml',
      'docker-compose.http.yml',
      'docker-compose.resources.yml',
    ]) {
      assert.ok(guide.includes(composeFile), `guide must compose ${composeFile}`);
    }
    assert.match(guide, /docker compose[\s\S]+stats --no-stream mcp-searxng/u);
    assert.match(guide, /docker compose[\s\S]+ps -q mcp-searxng/u);
    assert.ok(guide.includes('--name mcp-searxng-profile'));
    assert.ok(guide.includes('docker stats --no-stream mcp-searxng-profile'));
    assert.ok(guide.includes('disposable placeholder'));
    assert.ok(normalizedGuide.includes('passes no value for an optional variable'));
    assert.ok(normalizedGuide.includes('replaces those defaults'));
    assert.ok(normalizedGuide.includes('clients can spoof `X-Forwarded-For`'));
    assert.ok(normalizedGuide.includes('prints expanded environment values'));
    assert.ok(normalizedGuide.includes('differs from `MCP_HTTP_PORT`'));
    assert.ok(normalizedGuide.includes('published port in `MCP_HTTP_ALLOWED_HOSTS`'));
  }, results);

  await testFunction('public docs define the configurable search response default and precedence', () => {
    const readme = readText(new URL('../../README.md', import.meta.url));
    const configuration = readText(new URL('../../CONFIGURATION.md', import.meta.url));
    const precedence = 'If omitted, `SEARXNG_DEFAULT_RESPONSE_FORMAT` applies; if unset or invalid, `text` is used. An explicit `response_format` always takes precedence.';

    assert.ok(readme.includes('`SEARXNG_DEFAULT_RESPONSE_FORMAT`'));
    assert.ok(readme.includes(precedence));
    assert.ok(readme.includes('auto-inject `response_format=text`'));

    const searchDefaultsStart = configuration.indexOf('## Search Defaults');
    const resultControlsStart = configuration.indexOf('## Search Result Controls');
    assert.ok(searchDefaultsStart >= 0);
    assert.ok(resultControlsStart > searchDefaultsStart);
    const searchDefaults = configuration.slice(searchDefaultsStart, resultControlsStart);
    assert.ok(searchDefaults.includes('| `SEARXNG_DEFAULT_RESPONSE_FORMAT` |'));
    assert.ok(searchDefaults.includes('`text` or `json`'));
    assert.ok(searchDefaults.includes(precedence));
    assert.ok(searchDefaults.includes('auto-inject `response_format=text`'));
    assert.ok(configuration.includes('also applies when `SEARXNG_LITE_TOOLS=true`'));
    assert.ok(configuration.includes('callers that send `response_format` explicitly still override'));
    assert.ok(configuration.includes('"SEARXNG_DEFAULT_RESPONSE_FORMAT": "text"'));
  }, results);

  await testFunction('public docs define the optional stateless HTTP contract and fixed defaults', () => {
    const readme = readText(new URL('../../README.md', import.meta.url));
    const configuration = readText(new URL('../../CONFIGURATION.md', import.meta.url));
    const security = readText(new URL('../../SECURITY.md', import.meta.url));

    assert.equal(DEFAULT_STATELESS_MAX_IN_FLIGHT, 16);
    assert.equal(DEFAULT_STATELESS_MAX_IN_FLIGHT_PER_IP, 8);
    assert.equal(DEFAULT_STATELESS_REQUEST_TIMEOUT_MS, 900000);
    assert.equal(MAX_STATELESS_MAX_IN_FLIGHT, 256);

    for (const document of [readme, configuration, security]) {
      assert.ok(document.includes('`MCP_HTTP_STATELESS=true`'));
    }
    assert.ok(readme.includes('Stateless mode is POST-only'));
    assert.ok(readme.includes('Every stateless POST creates a fresh MCP server and transport'));

    for (const variable of [
      'MCP_HTTP_STATELESS',
      'MCP_HTTP_STATELESS_MAX_IN_FLIGHT',
      'MCP_HTTP_STATELESS_MAX_IN_FLIGHT_PER_IP',
      'MCP_HTTP_STATELESS_REQUEST_TIMEOUT_MS',
    ]) {
      assert.ok(configuration.includes(`\`${variable}\``), `configuration must define ${variable}`);
      assert.ok(configuration.includes(`"${variable}"`), `combined example must include ${variable}`);
    }
    assert.ok(configuration.includes('`16` (range `1`-`256`)'));
    assert.ok(configuration.includes('`8` (range `1`-global cap)'));
    assert.ok(configuration.includes('`900000` (range `1000`-`2147483647`)'));
    assert.ok(configuration.includes('HTTP 503'));
    assert.ok(configuration.includes('HTTP 504'));
    assert.ok(configuration.includes('negotiated JSON or an SSE stream within that same POST'));
    assert.ok(configuration.includes('Requests whose client IP cannot be resolved share one fail-closed capacity bucket'));

    assert.ok(security.includes('does not preserve cross-request sessions'));
    assert.ok(security.includes('global and per-client-IP in-flight caps'));
    assert.ok(security.includes('clients can spoof `X-Forwarded-For`'));
    assert.ok(security.includes('Requests whose client IP cannot be resolved share one fail-closed capacity bucket'));
  }, results);

  await testFunction('public documentation states current security, privacy, and configuration contracts', () => {
    const readme = readText(new URL('../../README.md', import.meta.url));
    const configuration = readText(new URL('../../CONFIGURATION.md', import.meta.url));
    const security = readText(new URL('../../SECURITY.md', import.meta.url));
    const normalizedSecurity = security.replace(/\s+/gu, ' ');
    const changelog = readText(new URL('../../CHANGELOG.md', import.meta.url));
    const index = readText(new URL('../../docs/index.md', import.meta.url));

    assert.ok(readme.includes('operator-controlled or trusted SearXNG instance'));
    assert.ok(readme.includes('As of 2026-07-29'));
    assert.ok(readme.includes('| Pagination | ✓ | ✗ | ✓ | ✓ |'));
    assert.ok(!readme.includes('| Privacy |'));

    assert.ok(configuration.includes('all SearXNG-bound traffic'));
    assert.ok(configuration.includes('## Combined Example (Representative Options)'));
    for (const variable of [
      '"AUTH_USERNAME"',
      '"AUTH_PASSWORD"',
      '"MCP_RATE_WINDOW_MS"',
      '"MCP_RATE_INIT_MAX"',
      '"MCP_RATE_SESSION_MAX"',
    ]) {
      assert.ok(configuration.includes(variable), `representative example must include ${variable}`);
    }
    assert.ok(configuration.includes('must be configured together'));
    assert.ok(configuration.includes('may be looser or stricter'));
    assert.ok(configuration.includes('clients can spoof `X-Forwarded-For`'));

    assert.ok(security.includes('Hardened mode protects the MCP protocol endpoint (`/mcp`)'));
    assert.ok(security.includes('`GET /health` intentionally remains unauthenticated'));
    assert.ok(security.includes('60 requests per minute'));
    assert.ok(normalizedSecurity.includes('`status`, `server`, `version`, and `transport`'));
    assert.ok(normalizedSecurity.includes('does not return the SearXNG URL or server configuration'));
    assert.ok(security.includes('version fingerprinting'));

    assert.ok(changelog.startsWith('# Changelog'));
    assert.ok(changelog.includes('## [Unreleased]'));
    assert.ok(changelog.includes('previously accepted numeric prefixes'));
    assert.ok(changelog.includes('may be looser or stricter'));

    for (const guide of [
      'client-configurations.md',
      'research-workflow.md',
      'deployment-profiles.md',
    ]) {
      assert.ok(index.includes(guide), `documentation index must link ${guide}`);
    }
  }, results);

  printTestSummary(results, 'Public Documentation Guides');
  return results;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  runTests().then((testResults) => {
    process.exit(testResults.failed > 0 ? 1 : 0);
  }).catch(console.error);
}
