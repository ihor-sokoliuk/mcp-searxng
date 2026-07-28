#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PATCHED_NODE_SERVER = Object.freeze([2, 0, 5]);
const EXPECTED_TOOLS = Object.freeze([
  'searxng_web_search',
  'web_url_read',
  'searxng_search_suggestions',
  'searxng_instance_info',
]);

function fail(category, message) {
  throw new Error(`${category}: ${message}`);
}

function parseStableSemver(value) {
  if (typeof value !== 'string') {
    fail('unsafe_dependency_tree', 'adapter version is missing');
  }
  const match = /^(\d+)\.(\d+)\.(\d+)(?:\+[0-9A-Za-z.-]+)?$/.exec(value);
  if (!match) {
    fail('unsafe_dependency_tree', `adapter version is invalid: ${value}`);
  }
  return match.slice(1, 4).map(Number);
}

function isAtLeastPatched(version) {
  for (let index = 0; index < PATCHED_NODE_SERVER.length; index += 1) {
    if (version[index] > PATCHED_NODE_SERVER[index]) return true;
    if (version[index] < PATCHED_NODE_SERVER[index]) return false;
  }
  return true;
}

export function assertSafeDependencyTree(tree) {
  if (!tree || typeof tree !== 'object' || Array.isArray(tree)) {
    fail('unsafe_dependency_tree', 'npm ls output is not an object');
  }

  const versions = [];
  const visit = (node) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
      fail('unsafe_dependency_tree', 'dependency node is malformed');
    }
    if (Array.isArray(node.problems) && node.problems.length > 0) {
      fail('unsafe_dependency_tree', `npm problems: ${node.problems.join('; ')}`);
    }
    const dependencies = node.dependencies;
    if (dependencies === undefined) return;
    if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) {
      fail('unsafe_dependency_tree', 'dependencies map is malformed');
    }
    for (const [name, dependency] of Object.entries(dependencies)) {
      if (!dependency || typeof dependency !== 'object' || Array.isArray(dependency)) {
        fail('unsafe_dependency_tree', `dependency ${name} is malformed`);
      }
      if (name === '@hono/node-server') {
        if (dependency.invalid) {
          fail('unsafe_dependency_tree', 'adapter is marked invalid');
        }
        if (dependency.extraneous) {
          fail('unsafe_dependency_tree', 'adapter is marked extraneous');
        }
        const parsed = parseStableSemver(dependency.version);
        if (!isAtLeastPatched(parsed)) {
          fail(
            'unsafe_dependency_tree',
            `adapter version ${dependency.version} is below 2.0.5`,
          );
        }
        versions.push(dependency.version);
      }
      visit(dependency);
    }
  };

  visit(tree);
  if (versions.length === 0) {
    fail('unsafe_dependency_tree', 'patched adapter dependency is missing');
  }
  return versions.sort((left, right) => left.localeCompare(right, undefined, {
    numeric: true,
  }));
}

export function assertZeroProductionAudit(report) {
  const vulnerabilities = report?.metadata?.vulnerabilities;
  if (!vulnerabilities || typeof vulnerabilities !== 'object') {
    fail('audit_gate', 'vulnerability metadata is missing');
  }
  if (typeof vulnerabilities.total !== 'number' || !Number.isFinite(vulnerabilities.total)) {
    fail('audit_gate', 'vulnerability total must be numeric');
  }
  if (vulnerabilities.total !== 0) {
    fail('audit_gate', `production audit reported ${vulnerabilities.total} vulnerabilities`);
  }
  return vulnerabilities;
}

export function assertArtifactMetadata(packReport, installedPackage) {
  if (!packReport || typeof packReport !== 'object') {
    fail('artifact_metadata', 'npm pack report is missing');
  }
  if (!Array.isArray(packReport.files)) {
    fail('artifact_metadata', 'npm pack file list is missing');
  }
  if (packReport.files.some(({ path: filePath }) => (
    typeof filePath === 'string'
    && filePath.toLowerCase() === 'npm-shrinkwrap.json'
  ))) {
    fail('artifact_metadata', 'npm shrinkwrap is forbidden');
  }
  if (!installedPackage || typeof installedPackage !== 'object') {
    fail('artifact_metadata', 'installed package manifest is missing');
  }
  if (installedPackage.dependencies?.['@hono/node-server'] !== undefined) {
    fail('artifact_metadata', 'direct @hono/node-server dependency is forbidden');
  }
  return true;
}

export function runCheckedCommand(command, args, {
  cwd,
  env,
  timeoutMs,
  input,
  spawn = spawnSync,
} = {}) {
  const result = spawn(command, args, {
    cwd,
    env,
    timeout: timeoutMs,
    input,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error?.code === 'ETIMEDOUT') {
    fail('infrastructure', `${command} timeout after ${timeoutMs}ms`);
  }
  if (result.error) {
    fail('infrastructure', `${command} spawn failed: ${result.error.message}`);
  }
  if (result.signal) {
    fail('infrastructure', `${command} terminated by ${result.signal}`);
  }
  if (result.status !== 0) {
    fail('infrastructure', `${command} exited with status ${result.status}`);
  }
  return result.stdout ?? '';
}

function runJsonCommand(command, args, {
  cwd,
  env,
  timeoutMs,
  spawn,
  label,
}) {
  const result = spawn(command, args, {
    cwd,
    env,
    timeout: timeoutMs,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error?.code === 'ETIMEDOUT') {
    fail('infrastructure', `${label} timeout after ${timeoutMs}ms`);
  }
  if (result.error) {
    fail('infrastructure', `${label} spawn failed: ${result.error.message}`);
  }
  if (result.signal) {
    fail('infrastructure', `${label} terminated by ${result.signal}`);
  }
  let json;
  try {
    json = JSON.parse(result.stdout ?? '');
  } catch {
    fail('infrastructure', `${label} returned invalid JSON`);
  }
  return { json, status: result.status };
}

export function assertMcpSmokeResponses(stdout) {
  const responses = new Map();
  for (const line of String(stdout).split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const message = JSON.parse(line);
      if (message && typeof message === 'object' && message.id !== undefined) {
        responses.set(message.id, message);
      }
    } catch {
      // Diagnostic lines are intentionally ignored; only JSON-RPC IDs are relevant.
    }
  }
  const initialize = responses.get(1);
  if (!initialize) fail('mcp_smoke', 'initialize response is missing');
  if (initialize.error) fail('mcp_smoke', 'initialize returned an error');
  if (!initialize.result || typeof initialize.result !== 'object') {
    fail('mcp_smoke', 'initialize result is malformed');
  }
  const toolsList = responses.get(2);
  if (!toolsList) fail('mcp_smoke', 'tools/list response is missing');
  if (toolsList.error) fail('mcp_smoke', 'tools/list returned an error');
  if (!Array.isArray(toolsList.result?.tools)) {
    fail('mcp_smoke', 'tools/list tools result is malformed');
  }
  const toolNames = new Set(
    toolsList.result.tools.map((tool) => tool?.name).filter(Boolean),
  );
  const missingTools = EXPECTED_TOOLS.filter((name) => !toolNames.has(name));
  if (missingTools.length > 0) {
    fail('mcp_smoke', `expected tools are missing: ${missingTools.join(', ')}`);
  }
  return toolsList.result.tools.length;
}

function findStepBlock(lines, commandIndex) {
  let start = commandIndex;
  while (start >= 0 && !/^\s{6}-\s/.test(lines[start])) start -= 1;
  if (start < 0) fail('workflow_contract', 'command is not inside a step');
  let end = commandIndex + 1;
  while (end < lines.length && !/^\s{6}-\s/.test(lines[end])) end += 1;
  return lines.slice(start, end);
}

export function assertPublishWorkflowContract(yamlText) {
  const lines = String(yamlText).split(/\r?\n/);
  const jobStart = lines.findIndex((line) => /^  build-and-publish:\s*$/.test(line));
  if (jobStart < 0) fail('workflow_contract', 'build-and-publish job is missing');
  let jobEnd = lines.length;
  for (let index = jobStart + 1; index < lines.length; index += 1) {
    if (/^  [A-Za-z0-9_-]+:\s*$/.test(lines[index])) {
      jobEnd = index;
      break;
    }
  }
  const jobLines = lines.slice(jobStart, jobEnd);
  if (jobLines.some((line) => /^\s{4}continue-on-error:\s*true\s*$/.test(line))) {
    fail('workflow_contract', 'job-level continue-on-error is forbidden');
  }

  const testIndex = jobLines.findIndex(
    (line) => /^\s+run:\s*.*\bnpm run test:coverage\b/.test(line),
  );
  const buildIndex = jobLines.findIndex(
    (line) => /^\s+run:\s*.*\bnpm run build\b/.test(line),
  );
  const verifierIndex = jobLines.findIndex(
    (line) => /^\s+run:\s*.*\bnpm run verify:packed-consumer\b/.test(line),
  );
  const publishIndex = jobLines.findIndex(
    (line) => /^\s+run:\s*.*\bnpm publish\b/.test(line),
  );
  if (testIndex < 0 || buildIndex < 0 || verifierIndex < 0 || publishIndex < 0) {
    fail('workflow_contract', 'tests, build, verifier, and publish must share one job');
  }
  if (!(
    testIndex < buildIndex
    && buildIndex < verifierIndex
    && verifierIndex < publishIndex
  )) {
    fail(
      'workflow_contract',
      'tests and build must run before the verifier, which must precede publish',
    );
  }

  const verifierStep = findStepBlock(jobLines, verifierIndex);
  const publishStep = findStepBlock(jobLines, publishIndex);
  for (const step of [verifierStep, publishStep]) {
    if (step.some((line) => /^\s+continue-on-error:\s*true\s*$/.test(line))) {
      fail('workflow_contract', 'step-level continue-on-error is forbidden');
    }
  }
  if (publishStep.some((line) => /^\s+if:\s*(?:always|failure)\s*\(\s*\)/.test(line))) {
    fail('workflow_contract', 'publish cannot run after a failed verifier');
  }
  if (verifierStep.some((line) => /\|\|\s*true|set\s+\+e/.test(line))) {
    fail('workflow_contract', 'verifier exit suppression is forbidden');
  }
  const verifierText = verifierStep.join('\n');
  const publishText = publishStep.join('\n');
  const outputMatch = /--output\s+("[^"]+"|'[^']+'|\S+)/.exec(verifierText);
  if (!outputMatch) {
    fail('workflow_contract', 'verifier output artifact is missing');
  }
  const escapedArtifact = outputMatch[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!new RegExp(`npm publish\\s+${escapedArtifact}(?:\\s|$)`).test(publishText)) {
    fail('workflow_contract', 'publish must use the exact verified artifact');
  }
  return true;
}

function allowlistedProcessEnvironment() {
  const allowedNames = [
    'PATH',
    'Path',
    'SystemRoot',
    'ComSpec',
    'PATHEXT',
    'TEMP',
    'TMP',
    'TMPDIR',
    'HOME',
    'USERPROFILE',
    'CI',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'no_proxy',
    'NODE_EXTRA_CA_CERTS',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
  ];
  return Object.fromEntries(
    allowedNames
      .filter((name) => process.env[name] !== undefined)
      .map((name) => [name, process.env[name]]),
  );
}

function isolatedNpmEnvironment(root) {
  const userConfig = path.join(root, 'user.npmrc');
  const globalConfig = path.join(root, 'global.npmrc');
  writeFileSync(userConfig, '', 'utf8');
  writeFileSync(globalConfig, '', 'utf8');
  return {
    ...allowlistedProcessEnvironment(),
    NPM_CONFIG_CACHE: path.join(root, 'cache'),
    NPM_CONFIG_USERCONFIG: userConfig,
    NPM_CONFIG_GLOBALCONFIG: globalConfig,
    NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org/',
  };
}

function mcpSmokeInput() {
  return [
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'packed-consumer-verifier', version: '1.0.0' },
      },
    },
    {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
      params: {},
    },
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    },
  ].map((message) => JSON.stringify(message)).join('\n') + '\n';
}

function npmInvocation(args) {
  if (process.platform !== 'win32') {
    return { command: 'npm', args };
  }
  const bundledNpm = path.join(
    path.dirname(process.execPath),
    'node_modules',
    'npm',
    'bin',
    'npm-cli.js',
  );
  const npmCli = (
    process.env.npm_execpath
    && existsSync(process.env.npm_execpath)
  )
    ? process.env.npm_execpath
    : bundledNpm;
  if (!existsSync(npmCli)) {
    fail('infrastructure', 'npm CLI entrypoint is unavailable');
  }
  return {
    command: process.execPath,
    args: [npmCli, ...args],
  };
}

export function verifyPackedConsumer({
  projectRoot = process.cwd(),
  artifactOutput,
  spawn = spawnSync,
} = {}) {
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'mcp-searxng-packed-consumer-'));
  const artifactDirectory = path.join(temporaryRoot, 'artifact');
  const consumerDirectory = path.join(temporaryRoot, 'consumer');
  try {
    mkdirSync(artifactDirectory);
    mkdirSync(consumerDirectory);
    const npmEnvironment = isolatedNpmEnvironment(temporaryRoot);
    const packInvocation = npmInvocation([
        'pack',
        '--json',
        '--ignore-scripts',
        '--pack-destination',
        artifactDirectory,
    ]);
    const packOutput = runCheckedCommand(
      packInvocation.command,
      packInvocation.args,
      {
        cwd: projectRoot,
        env: npmEnvironment,
        timeoutMs: 300_000,
        spawn,
      },
    );
    let packedArtifacts;
    try {
      packedArtifacts = JSON.parse(packOutput);
    } catch {
      fail('infrastructure', 'npm pack returned invalid JSON');
    }
    if (
      !Array.isArray(packedArtifacts)
      || packedArtifacts.length !== 1
      || typeof packedArtifacts[0]?.filename !== 'string'
    ) {
      fail('infrastructure', 'npm pack did not report exactly one artifact');
    }
    const artifactPath = path.join(artifactDirectory, packedArtifacts[0].filename);
    if (!existsSync(artifactPath)) {
      fail('infrastructure', 'npm pack reported an artifact that does not exist');
    }

    writeFileSync(
      path.join(consumerDirectory, 'package.json'),
      `${JSON.stringify({
        name: 'mcp-searxng-packed-consumer-verifier',
        version: '1.0.0',
        private: true,
        dependencies: {
          'mcp-searxng': pathToFileURL(artifactPath).href,
        },
      }, null, 2)}\n`,
      'utf8',
    );

    const installInvocation = npmInvocation([
        'install',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--fetch-retries=2',
        '--fetch-timeout=60000',
    ]);
    runCheckedCommand(
      installInvocation.command,
      installInvocation.args,
      {
        cwd: consumerDirectory,
        env: npmEnvironment,
        timeoutMs: 300_000,
        spawn,
      },
    );

    const installedManifestPath = path.join(
      consumerDirectory,
      'node_modules',
      'mcp-searxng',
      'package.json',
    );
    let installedPackage;
    try {
      installedPackage = JSON.parse(readFileSync(installedManifestPath, 'utf8'));
    } catch {
      fail('artifact_metadata', 'installed package manifest is unreadable');
    }
    assertArtifactMetadata(packedArtifacts[0], installedPackage);

    const treeInvocation = npmInvocation(
      ['ls', '--all', '--json'],
    );
    const treeResult = runJsonCommand(
      treeInvocation.command,
      treeInvocation.args,
      {
        cwd: consumerDirectory,
        env: npmEnvironment,
        timeoutMs: 300_000,
        spawn,
        label: 'npm ls',
      },
    );
    const adapterVersions = assertSafeDependencyTree(treeResult.json);
    if (treeResult.status !== 0) {
      fail('infrastructure', `npm ls exited with status ${treeResult.status}`);
    }

    const auditInvocation = npmInvocation(
      ['audit', '--omit=dev', '--json'],
    );
    const auditResult = runJsonCommand(
      auditInvocation.command,
      auditInvocation.args,
      {
        cwd: consumerDirectory,
        env: npmEnvironment,
        timeoutMs: 300_000,
        spawn,
        label: 'npm audit',
      },
    );
    const audit = assertZeroProductionAudit(auditResult.json);
    if (auditResult.status !== 0) {
      fail('infrastructure', `npm audit exited with status ${auditResult.status}`);
    }

    const cliPath = path.join(
      consumerDirectory,
      'node_modules',
      'mcp-searxng',
      'dist',
      'cli.js',
    );
    if (!existsSync(cliPath) && spawn === spawnSync) {
      fail('infrastructure', 'packed CLI is missing after installation');
    }
    const smokeOutput = runCheckedCommand(
      process.execPath,
      [path.join('node_modules', 'mcp-searxng', 'dist', 'cli.js')],
      {
        cwd: consumerDirectory,
        env: {
          ...allowlistedProcessEnvironment(),
          SEARXNG_URL: 'https://packed-consumer.invalid',
        },
        timeoutMs: 30_000,
        input: mcpSmokeInput(),
        spawn,
      },
    );
    const toolCount = assertMcpSmokeResponses(smokeOutput);
    if (artifactOutput) {
      copyFileSync(artifactPath, path.resolve(artifactOutput));
    }

    return {
      adapterVersions,
      auditTotal: audit.total,
      toolCount,
    };
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const args = process.argv.slice(2);
    let artifactOutput;
    for (let index = 0; index < args.length; index += 2) {
      const option = args[index];
      const value = args[index + 1];
      if (!value) {
        fail(
          'infrastructure',
          'usage: verify-packed-consumer.mjs [--output artifact.tgz]',
        );
      }
      if (option === '--output' && artifactOutput === undefined) {
        artifactOutput = value;
      } else {
        fail(
          'infrastructure',
          'usage: verify-packed-consumer.mjs [--output artifact.tgz]',
        );
      }
    }
    const outcome = verifyPackedConsumer({ artifactOutput });
    process.stdout.write(
      `packed-consumer verification passed: adapters=${outcome.adapterVersions.join(',')} audit=${outcome.auditTotal} tools=${outcome.toolCount}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
