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
import {
  assertArtifactMetadata,
  assertMcpSmokeResponses,
  assertSafeDependencyTree,
  assertZeroProductionAudit,
  fail,
} from './packed-consumer-contracts.mjs';

export {
  assertArtifactMetadata,
  assertMcpSmokeResponses,
  assertPublishWorkflowContract,
  assertSafeDependencyTree,
  assertZeroProductionAudit,
} from './packed-consumer-contracts.mjs';

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
    const operation = args.at(0);
    const commandLabel = operation ? `${command} ${operation}` : command;
    fail('infrastructure', `${commandLabel} exited with status ${result.status}`);
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

function allowlistedProcessEnvironment() {
  const {
    PATH, Path, SystemRoot, ComSpec, PATHEXT, TEMP, TMP, TMPDIR, HOME,
    USERPROFILE, CI, HTTP_PROXY, HTTPS_PROXY, NO_PROXY, http_proxy,
    https_proxy, no_proxy, NODE_EXTRA_CA_CERTS, SSL_CERT_FILE, SSL_CERT_DIR,
  } = process.env;
  return Object.fromEntries(Object.entries({
    PATH, Path, SystemRoot, ComSpec, PATHEXT, TEMP, TMP, TMPDIR, HOME,
    USERPROFILE, CI, HTTP_PROXY, HTTPS_PROXY, NO_PROXY, http_proxy,
    https_proxy, no_proxy, NODE_EXTRA_CA_CERTS, SSL_CERT_FILE, SSL_CERT_DIR,
  }).filter(([, value]) => value !== undefined));
}

function isolatedNpmEnvironment(root) {
  const userConfig = path.join(root, 'user.npmrc');
  const globalConfig = path.join(root, 'global.npmrc');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- root is created by mkdtempSync for this verifier
  writeFileSync(userConfig, '', 'utf8');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- root is created by mkdtempSync for this verifier
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

function packedPdfSmokeScript() {
  const fixture =
    'JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA0IDAgUiA+PiA+PiAvQ29udGVudHMgNSAwIFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVuZG9iago1IDAgb2JqCjw8IC9MZW5ndGggNDggPj4Kc3RyZWFtCkJUIC9GMSAxMiBUZiA3MiA3MjAgVGQgKFBhY2tlZCBQREYgd29ya2VyKSBUaiBFVAplbmRzdHJlYW0KZW5kb2JqCnhyZWYKMCA2CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAwOSAwMDAwMCBuIAowMDAwMDAwMDU4IDAwMDAwIG4gCjAwMDAwMDAxMTUgMDAwMDAgbiAKMDAwMDAwMDI0MSAwMDAwMCBuIAowMDAwMDAwMzExIDAwMDAwIG4gCnRyYWlsZXIKPDwgL1NpemUgNiAvUm9vdCAxIDAgUiA+PgpzdGFydHhyZWYKNDA5CiUlRU9GCg==';
  return [
    "import path from 'node:path';",
    "import { pathToFileURL } from 'node:url';",
    "for (const target of ['mcp-searxng', 'mcp-searxng/dist/index.js']) {",
    "  let blocked = false;",
    "  try { await import(target); } catch (error) {",
    "    if (error?.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error;",
    "    blocked = true;",
    "  }",
    "  if (!blocked) process.exit(1);",
    "}",
    "const moduleUrl = pathToFileURL(path.resolve('node_modules/mcp-searxng/dist/pdf-reader.js')).href;",
    "const { extractPdfText } = await import(moduleUrl);",
    `const bytes = new Uint8Array(Buffer.from('${fixture}', 'base64'));`,
    "const result = await extractPdfText(bytes, 1024);",
    "if (result.kind !== 'text' || !result.text.includes('Packed PDF worker')) process.exit(1);",
    "process.stdout.write('packed-pdf-ok\\n');",
  ].join('\n');
}

function copyVerifiedArtifact(artifactPath, artifactOutput) {
  try {
    copyFileSync(artifactPath, path.resolve(artifactOutput));
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error
      ? error.code
      : 'copy failed';
    fail('infrastructure', `verified artifact output failed: ${code}`);
  }
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
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is derived from the trusted Node executable location
  if (!existsSync(bundledNpm)) {
    fail('infrastructure', 'npm CLI entrypoint is unavailable');
  }
  return {
    command: process.execPath,
    args: [bundledNpm, ...args],
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
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is under the verifier-created temporary root
    mkdirSync(artifactDirectory);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is under the verifier-created temporary root
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
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- npm pack reports a file in the verifier-owned artifact directory
    if (!existsSync(artifactPath)) {
      fail('infrastructure', 'npm pack reported an artifact that does not exist');
    }

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is under the verifier-created temporary consumer
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
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is fixed beneath the verifier-created consumer
      installedPackage = JSON.parse(readFileSync(installedManifestPath, 'utf8'));
    } catch {
      fail('artifact_metadata', 'installed package manifest is unreadable');
    }
    assertArtifactMetadata(packedArtifacts[0], installedPackage);

    const installedPdfWorkerPath = path.join(
      consumerDirectory,
      'node_modules',
      'mcp-searxng',
      'dist',
      'pdf-worker.js',
    );
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is fixed beneath the verifier-created consumer
    if (!existsSync(installedPdfWorkerPath) && spawn === spawnSync) {
      fail('artifact_metadata', 'installed PDF worker is missing');
    }
    const pdfSmokeOutput = runCheckedCommand(
      process.execPath,
      ['--input-type=module', '--eval', packedPdfSmokeScript()],
      {
        cwd: consumerDirectory,
        env: allowlistedProcessEnvironment(),
        timeoutMs: 30_000,
        spawn,
      },
    );
    if (pdfSmokeOutput.trim() !== 'packed-pdf-ok') {
      fail('artifact_runtime', 'installed PDF worker did not extract fixture text');
    }

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
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is fixed beneath the verifier-created consumer
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
      copyVerifiedArtifact(artifactPath, artifactOutput);
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
      const option = args.at(index);
      const value = args.at(index + 1);
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
      `packed-consumer verification passed: sdk=${outcome.adapterVersions.map(({ name, version }) => `${name}@${version}`).join(',')} audit=${outcome.auditTotal} tools=${outcome.toolCount}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
