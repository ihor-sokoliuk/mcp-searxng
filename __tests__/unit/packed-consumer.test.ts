#!/usr/bin/env tsx

import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  assertMcpSmokeResponses, assertArtifactMetadata, assertPublishWorkflowContract,
  assertSafeDependencyTree, assertZeroProductionAudit, runCheckedCommand,
  verifyPackedConsumer,
} from '../../scripts/verify-packed-consumer.mjs';
import {
  createTestResults,
  printTestSummary,
  testFunction,
  TestResult,
} from '../helpers/test-utils.js';
import {
  commandResult, invalidPublishWorkflows, safeTree, SpawnCall,
  treeWithNodeServer, validMcpSmokeOutput, validWorkflow, zeroAudit,
} from './packed-consumer-fixtures.js';

const results = createTestResults();

async function runDependencyContractTests(): Promise<void> {
  await testFunction('accepts a clean dependency tree containing only patched adapter copies', () => {
    assert.deepEqual(assertSafeDependencyTree(safeTree), ['2.0.12']);
    const duplicateSafeTree = {
      ...safeTree,
      dependencies: {
        ...safeTree.dependencies,
        '@hono/node-server': { version: '2.0.5' },
      },
    };
    assert.deepEqual(
      assertSafeDependencyTree(duplicateSafeTree),
      ['2.0.5', '2.0.12'],
    );
  }, results);

  await testFunction('rejects every vulnerable, prerelease, missing, or malformed adapter tree', () => {
    assert.throws(
      () => assertSafeDependencyTree(treeWithNodeServer({ version: '1.19.17' })),
      /unsafe_dependency_tree:.*1\.19\.17/,
    );
    assert.throws(
      () => assertSafeDependencyTree(treeWithNodeServer({ version: '2.0.5-beta.1' })),
      /unsafe_dependency_tree:.*2\.0\.5-beta\.1/,
    );
    assert.throws(
      () => assertSafeDependencyTree({ name: 'consumer', dependencies: {} }),
      /unsafe_dependency_tree:.*missing/,
    );
    assert.throws(
      () => assertSafeDependencyTree(treeWithNodeServer({})),
      /unsafe_dependency_tree:.*version/,
    );
    assert.throws(
      () => assertSafeDependencyTree(treeWithNodeServer({ version: 'not-semver' })),
      /unsafe_dependency_tree:.*not-semver/,
    );
  }, results);

  await testFunction('rejects invalid, extraneous, npm-problem, and mixed-version trees', () => {
    assert.throws(
      () => assertSafeDependencyTree(treeWithNodeServer({ version: '2.0.12', invalid: true })),
      /unsafe_dependency_tree:.*invalid/,
    );
    assert.throws(
      () => assertSafeDependencyTree(treeWithNodeServer({ version: '2.0.12', extraneous: true })),
      /unsafe_dependency_tree:.*extraneous/,
    );
    assert.throws(
      () => assertSafeDependencyTree({
        ...safeTree,
        problems: ['invalid: dependency tree'],
      }),
      /unsafe_dependency_tree:.*problems/,
    );
    assert.throws(
      () => assertSafeDependencyTree({
        ...safeTree,
        dependencies: {
          ...safeTree.dependencies,
          '@hono/node-server': { version: '1.19.17' },
        },
      }),
      /unsafe_dependency_tree:.*1\.19\.17/,
    );
  }, results);

  await testFunction('accepts only a well-formed zero-total production audit', () => {
    assert.deepEqual(
      assertZeroProductionAudit({
        metadata: {
          vulnerabilities: {
            info: 0,
            low: 0,
            moderate: 0,
            high: 0,
            critical: 0,
            total: 0,
          },
        },
      }),
      {
        info: 0,
        low: 0,
        moderate: 0,
        high: 0,
        critical: 0,
        total: 0,
      },
    );
    assert.throws(
      () => assertZeroProductionAudit({
        metadata: { vulnerabilities: { total: 1 } },
      }),
      /audit_gate:.*1/,
    );
    assert.throws(
      () => assertZeroProductionAudit({ metadata: {} }),
      /audit_gate:.*metadata/,
    );
    assert.throws(
      () => assertZeroProductionAudit({
        metadata: { vulnerabilities: { total: '0' } },
      }),
      /audit_gate:.*numeric/,
    );
  }, results);
}

async function runProcessContractTests(): Promise<void> {
  await testFunction('classifies command timeout, spawn, signal, and exit failures as infrastructure errors', () => {
    const baseOptions = { cwd: '.', env: {}, timeoutMs: 1000 };
    assert.throws(
      () => runCheckedCommand('npm', ['install'], {
        ...baseOptions,
        spawn: () => commandResult({
          error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }),
          status: null,
        }),
      }),
      /infrastructure:.*timeout/,
    );
    assert.throws(
      () => runCheckedCommand('npm', ['install'], {
        ...baseOptions,
        spawn: () => commandResult({
          error: new Error('spawn failed'),
          status: null,
        }),
      }),
      /infrastructure:.*spawn failed/,
    );
    assert.throws(
      () => runCheckedCommand('npm', ['install'], {
        ...baseOptions,
        spawn: () => commandResult({
          status: null,
          signal: 'SIGTERM',
        }),
      }),
      /infrastructure:.*SIGTERM/,
    );
    assert.throws(
      () => runCheckedCommand('npm', ['install'], {
        ...baseOptions,
        spawn: () => commandResult({
          status: 1,
          stderr: 'registry unavailable',
        }),
      }),
      /infrastructure:.*npm install.*status 1/,
    );
  }, results);

  await testFunction('accepts successful MCP initialize and tools/list responses from the packed CLI', () => {
    assert.equal(assertMcpSmokeResponses(validMcpSmokeOutput()), 4);
    assert.throws(
      () => assertMcpSmokeResponses(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools: [] } })),
      /mcp_smoke:.*initialize/,
    );
    assert.throws(
      () => assertMcpSmokeResponses([
        JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -1 } }),
        JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools: [] } }),
      ].join('\n')),
      /mcp_smoke:.*error/,
    );
    assert.throws(
      () => assertMcpSmokeResponses([
        JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }),
        JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools: 'invalid' } }),
      ].join('\n')),
      /mcp_smoke:.*tools/,
    );
    assert.throws(
      () => assertMcpSmokeResponses([
        JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }),
        JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools: [] } }),
      ].join('\n')),
      /mcp_smoke:.*expected/,
    );
  }, results);
}

async function runWorkflowContractTests(): Promise<void> {
  await testFunction('requires an unsuppressed verifier before publish in the same job', () => {
    assert.equal(assertPublishWorkflowContract(validWorkflow), true);

    for (const workflow of invalidPublishWorkflows) {
      assert.throws(
        () => assertPublishWorkflowContract(workflow),
        /workflow_contract:/,
      );
    }
  }, results);

  await testFunction('rejects forbidden metadata from the packed artifact', () => {
    assert.equal(
      assertArtifactMetadata(
        {
          filename: 'mcp-searxng-1.12.0.tgz',
          files: [
            { path: 'package.json' },
            { path: 'dist/cli.js' },
            { path: 'dist/pdf-worker.js' },
          ],
        },
        {
          name: 'mcp-searxng',
          dependencies: {
            '@modelcontextprotocol/sdk': '1.30.0',
          },
        },
      ),
      true,
    );
    assert.throws(
      () => assertArtifactMetadata(
        {
          filename: 'mcp-searxng-1.12.0.tgz',
          files: [
            { path: 'package.json' },
            { path: 'npm-shrinkwrap.json' },
          ],
        },
        { name: 'mcp-searxng', dependencies: {} },
      ),
      /artifact_metadata:.*shrinkwrap/,
    );
    assert.throws(
      () => assertArtifactMetadata(
        {
          filename: 'mcp-searxng-1.12.0.tgz',
          files: [{ path: 'package.json' }, { path: 'dist/pdf-worker.js' }],
        },
        {
          name: 'mcp-searxng',
          dependencies: { '@hono/node-server': '2.0.12' },
        },
      ),
      /artifact_metadata:.*direct/,
    );
    assert.throws(
      () => assertArtifactMetadata(
        { filename: 'mcp-searxng-1.12.0.tgz', files: [null] },
        { name: 'mcp-searxng', dependencies: {} },
      ),
      /artifact_metadata:.*file entry/,
    );
    assert.throws(
      () => assertArtifactMetadata(
        {
          filename: 'mcp-searxng-1.12.0.tgz',
          files: [{ path: 'package.json' }, { path: 'dist/cli.js' }],
        },
        { name: 'mcp-searxng', dependencies: {} },
      ),
      /artifact_metadata:.*pdf-worker\.js/,
    );
  }, results);

  await testFunction('the public npm release workflow enforces the packed-consumer gate', () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- repository-relative URL is a fixed test input
    const workflow = readFileSync(
      new URL('../../.github/workflows/npm-publish.yml', import.meta.url),
      'utf8',
    );
    assert.equal(assertPublishWorkflowContract(workflow), true);
  }, results);
}

async function runOrchestrationTests(): Promise<void> {
  await testFunction('packs, installs, validates, audits, and smokes an isolated consumer in order', () => {
    const calls: SpawnCall[] = [];
    let temporaryRoot = '';
    const artifactOutput = path.join(tmpdir(), `mcp-searxng-verified-${process.pid}-${Date.now()}.tgz`);
    const credentialVariable = ['NODE', 'AUTH', 'TOKEN'].join('_');
    const previousCredential = process.env[credentialVariable];
    process.env[credentialVariable] = 'fixture-release-credential';
    // #lizard forgives -- fake process dispatch mirrors five deterministic commands
    const spawn = (
      command: string,
      args: string[],
      options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number },
    ) => {
      calls.push({ command, args, options });
      if (args.includes('pack')) {
        const destination = args[args.indexOf('--pack-destination') + 1];
        temporaryRoot = path.dirname(destination);
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- destination is the verifier-created temporary artifact directory
        writeFileSync(path.join(destination, 'mcp-searxng-1.12.0.tgz'), 'fixture');
        return {
          status: 0,
          signal: null,
          stdout: JSON.stringify([{
            filename: 'mcp-searxng-1.12.0.tgz',
            files: [
              { path: 'package.json' },
              { path: 'dist/cli.js' },
              { path: 'dist/pdf-worker.js' },
            ],
          }]),
          stderr: '',
        };
      }
      if (args.includes('install')) {
        const consumerPackage = JSON.parse(
          // eslint-disable-next-line security/detect-non-literal-fs-filename -- cwd is the verifier-created temporary consumer directory
          readFileSync(path.join(options.cwd!, 'package.json'), 'utf8'),
        );
        assert.match(
          consumerPackage.dependencies['mcp-searxng'],
          /^file:.*mcp-searxng-1\.12\.0\.tgz$/,
        );
        const installedPackageDirectory = path.join(options.cwd!, 'node_modules', 'mcp-searxng');
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- directory belongs to the verifier-created temporary consumer
        mkdirSync(installedPackageDirectory, { recursive: true });
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- directory belongs to the verifier-created temporary consumer
        writeFileSync(
          path.join(installedPackageDirectory, 'package.json'),
          JSON.stringify({
            name: 'mcp-searxng',
            dependencies: { '@modelcontextprotocol/sdk': '1.30.0' },
          }),
        );
        return { status: 0, signal: null, stdout: '', stderr: '' };
      }
      if (args.includes('ls')) {
        return {
          status: 0,
          signal: null,
          stdout: JSON.stringify(safeTree),
          stderr: '',
        };
      }
      if (args.includes('audit')) {
        return {
          status: 0,
          signal: null,
          stdout: JSON.stringify(zeroAudit),
          stderr: '',
        };
      }
      if (args.includes('--input-type=module')) {
        return { status: 0, signal: null, stdout: 'packed-pdf-ok\n', stderr: '' };
      }
      return {
        status: 0,
        signal: null,
        stdout: validMcpSmokeOutput(),
        stderr: '',
      };
    };

    let outcome;
    try {
      outcome = verifyPackedConsumer({
        projectRoot: process.cwd(),
        artifactOutput,
        spawn,
      });
    } finally {
      if (previousCredential === undefined) {
        delete process.env[credentialVariable];
      } else {
        process.env[credentialVariable] = previousCredential;
      }
    }

    assert.deepEqual(outcome.adapterVersions, ['2.0.12']);
    assert.equal(outcome.auditTotal, 0);
    assert.equal(outcome.toolCount, 4);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- unique test output is created under the OS temporary directory
    assert.equal(readFileSync(artifactOutput, 'utf8'), 'fixture');
    assert.deepEqual(
      calls.map(({ args }) => (
        args.find((argument) => ['pack', 'install', 'ls', 'audit'].includes(argument))
        ?? args[0]
      )),
      ['pack', 'install', '--input-type=module', 'ls', 'audit', path.join('node_modules', 'mcp-searxng', 'dist', 'cli.js')],
    );
    const installCall = calls[1];
    assert.ok(installCall.args.includes('--ignore-scripts'));
    assert.ok(installCall.args.includes('--fetch-retries=2'));
    assert.ok(installCall.args.includes('--fetch-timeout=60000'));
    assert.equal(installCall.options.timeout, 300_000);
    assert.equal(installCall.options.env?.NPM_CONFIG_REGISTRY, 'https://registry.npmjs.org/');
    for (const call of calls) {
      assert.equal(call.options.env?.[credentialVariable], undefined);
    }
    const lsCall = calls.find(({ args }) => args.includes('ls'));
    assert.deepEqual(lsCall?.args.slice(lsCall.args.indexOf('ls')), ['ls', '--all', '--json']);
    assert.ok(installCall.options.env?.NPM_CONFIG_CACHE?.startsWith(temporaryRoot));
    assert.ok(installCall.options.env?.NPM_CONFIG_USERCONFIG?.startsWith(temporaryRoot));
    assert.ok(installCall.options.env?.NPM_CONFIG_GLOBALCONFIG?.startsWith(temporaryRoot));
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path was captured from the verifier-created temporary directory
    assert.equal(existsSync(temporaryRoot), false);
    rmSync(artifactOutput, { force: true });
  }, results);

  await testFunction('removes the isolated consumer after a command failure', () => {
    let temporaryRoot = '';
    const spawn = (
      _command: string,
      args: string[],
      _options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number },
    ) => {
      if (args.includes('pack')) {
        const destination = args[args.indexOf('--pack-destination') + 1];
        temporaryRoot = path.dirname(destination);
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- destination is the verifier-created temporary artifact directory
        writeFileSync(path.join(destination, 'mcp-searxng-1.12.0.tgz'), 'fixture');
        return {
          status: 0,
          signal: null,
          stdout: JSON.stringify([{
            filename: 'mcp-searxng-1.12.0.tgz',
            files: [
              { path: 'package.json' },
              { path: 'dist/cli.js' },
              { path: 'dist/pdf-worker.js' },
            ],
          }]),
          stderr: '',
        };
      }
      if (args.includes('install')) {
        const installedPackageDirectory = path.join(_options.cwd!, 'node_modules', 'mcp-searxng');
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- directory belongs to the verifier-created temporary consumer
        mkdirSync(installedPackageDirectory, { recursive: true });
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- directory belongs to the verifier-created temporary consumer
        writeFileSync(
          path.join(installedPackageDirectory, 'package.json'),
          JSON.stringify({
            name: 'mcp-searxng',
            dependencies: { '@modelcontextprotocol/sdk': '1.30.0' },
          }),
        );
      }
      if (args.includes('--input-type=module')) {
        return { status: 0, signal: null, stdout: 'packed-pdf-ok\n', stderr: '' };
      }
      if (args.includes('ls')) {
        return {
          status: 1,
          signal: null,
          stdout: JSON.stringify(safeTree),
          stderr: 'dependency tree unavailable',
        };
      }
      return { status: 0, signal: null, stdout: '', stderr: '' };
    };

    assert.throws(
      () => verifyPackedConsumer({ projectRoot: process.cwd(), spawn }),
      /infrastructure:.*status 1/,
    );
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path was captured from the verifier-created temporary directory
    assert.equal(existsSync(temporaryRoot), false);
  }, results);
}

export async function runTests(): Promise<TestResult> {
  console.log('Testing: packed consumer release verification\n');
  await runDependencyContractTests();
  await runProcessContractTests();
  await runWorkflowContractTests();
  await runOrchestrationTests();
  printTestSummary(results, 'Packed Consumer Verification');
  return results;
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runTests().then((result) => {
    if (result.failed > 0) process.exitCode = 1;
  });
}
