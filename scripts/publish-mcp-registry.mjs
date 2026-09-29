import { execFile } from 'node:child_process';
import { readFileSync, appendFileSync } from 'node:fs';
import { isDeepStrictEqual, promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const execute = promisify(execFile);
export const RECOVERY_MS = 15 * 60 * 1000;
export const FINAL_CHECK_MS = 5000;
const PACKAGE = 'mcp-searxng';
const SERVER = 'io.github.ihor-sokoliuk/mcp-searxng';
const REPOSITORY = 'ihor-sokoliuk/mcp-searxng';
const NETWORK_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET']);
const NETWORK_MESSAGES = ['connection reset by peer', 'connection refused', 'i/o timeout', 'tls handshake timeout', 'context deadline exceeded', 'temporary failure in name resolution'];

export function validateVersion(version) {
  if (typeof version !== 'string' || version.length > 100) throw new Error('Invalid release version.');
  const [core, ...suffix] = version.split('-');
  if (!/^\d+\.\d+\.\d+$/.test(core)) throw new Error('Invalid release version.');
  if (suffix.length > 0 && !/^[\w.-]+$/.test(suffix.join('-'))) throw new Error('Invalid release version.');
  return version;
}

export function validateManifest(manifest, pkg) {
  validateVersion(pkg.version);
  if (manifest.version !== pkg.version || manifest.name !== SERVER || pkg.mcpName !== SERVER) {
    throw new Error('Release metadata does not match package.json.');
  }
  const repository = `https://github.com/${REPOSITORY}`;
  if (manifest.repository?.url !== repository || pkg.repository?.url !== repository) throw new Error('Unexpected release repository.');
  return validatePackage(manifest, pkg);
}

function validatePackage(manifest, pkg) {
  if (manifest.packages?.length !== 1) throw new Error('Expected exactly one npm package.');
  const entry = manifest.packages[0];
  if (entry.registryType !== 'npm' || entry.identifier !== PACKAGE || pkg.name !== PACKAGE || entry.version !== pkg.version) {
    throw new Error('Expected the npm package at the release version.');
  }
  return entry;
}

export function validateRelease(event, repository, manifest, pkg) {
  validateManifest(manifest, pkg);
  const run = event.workflow_run;
  const expected = { conclusion: 'success', event: 'push', path: '.github/workflows/npm-publish.yml', repository: REPOSITORY, tag: `v${manifest.version}` };
  const actual = { conclusion: run?.conclusion, event: run?.event, path: run?.path, repository: run?.head_repository?.full_name, tag: run?.head_branch };
  if (repository !== REPOSITORY || !isDeepStrictEqual(actual, expected) || !/^[a-f0-9]{40}$/.test(run?.head_sha ?? '')) {
    throw new Error('Registry publication requires a successful npm release run from this repository and exact version tag.');
  }
}

export function transientStatus(status) {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

function npmPropagationFailure(output, entry) {
  return output.includes('registry validation failed for package')
    && output.includes(`NPM package '${entry.identifier}' exists, but version '${entry.version}' was not found (status: 404)`);
}

function publisherHttpStatus(output) {
  return Number(output.match(/server returned status (\d{3})\b/)?.[1]);
}

function networkFailure(output) {
  const message = output.toLowerCase();
  return NETWORK_MESSAGES.some(fragment => message.includes(fragment)) ? 'temporary network failure' : null;
}

export function classifyPublishFailure(output, entry) {
  const status = publisherHttpStatus(output);
  if (status === 409) return 'conflict';
  if (transientStatus(status)) return 'temporary registry response';
  if (status === 400 && npmPropagationFailure(output, entry)) return 'npm version is not yet visible to MCP Registry';
  if (status) return null;
  return networkFailure(output);
}

export async function getJson(service, version, timeoutMs) {
  // Only the bounded, validated release tag from the workflow environment goes
  // into these paths. Package/manifest file contents never select a destination.
  validateVersion(version);
  const options = { signal: AbortSignal.timeout(timeoutMs), redirect: 'error', headers: { accept: 'application/json' } };
  try {
    const response = service === 'npm'
      ? await fetch(`https://registry.npmjs.org/mcp-searxng/${version}`, options)
      : await fetch(`https://registry.modelcontextprotocol.io/v0.1/servers/io.github.ihor-sokoliuk%2Fmcp-searxng/versions/${version}`, options);
    return await readJsonResponse(response);
  } catch (error) {
    if (error.name === 'TimeoutError' || NETWORK_CODES.has(error.cause?.code ?? error.code)) return { status: 503 };
    throw error;
  }
}

async function readJsonResponse(response) {
  if (response.ok) return { status: response.status, data: await response.json() };
  await response.body?.cancel();
  return { status: response.status };
}

async function command(args, timeoutMs) {
  try {
    const result = await execute('mcp-publisher', args, { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 });
    return { ok: true, output: result.stdout + result.stderr };
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('mcp-publisher is not installed.');
    return { ok: false, timedOut: !!error.killed, output: `${error.stdout ?? ''}\n${error.stderr ?? ''}` };
  }
}

function normalizePackages(packages) {
  // Registry JSON omits false boolean defaults when serializing env inputs.
  return packages?.map(entry => ({ ...entry, environmentVariables: entry.environmentVariables?.map(variable => ({
    ...variable,
    isRequired: variable.isRequired === undefined ? false : variable.isRequired,
    isSecret: variable.isSecret === undefined ? false : variable.isSecret,
  })) }));
}

function registryIdentity(server) {
  return { name: server?.name, version: server?.version, repository: server?.repository, packages: normalizePackages(server?.packages) };
}

function assertRegistryRecord(data, manifest) {
  if (!isDeepStrictEqual(registryIdentity(manifest), registryIdentity(data?.server))
      || data?._meta?.['io.modelcontextprotocol.registry/official']?.status !== 'active') {
    throw new Error('Existing registry version does not match the expected active release; refusing to overwrite it.');
  }
}

function createRecovery({ now, wait, log, budgetMs }) {
  const start = now();
  const deadline = start + budgetMs;
  const finalReserve = Math.min(FINAL_CHECK_MS, Math.floor(budgetMs / 2));
  let delay = 10_000;
  function remaining() {
    const value = deadline - now();
    if (value <= 0) throw new Error('MCP Registry publication was not verified within the recovery window. npm remains published; rerun only this registry workflow.');
    return value;
  }
  function retry(reason) {
    const duration = Math.min(delay, Math.max(0, remaining() - finalReserve));
    log(`Waiting: ${reason}. Checking again in ${Math.ceil(duration / 1000)} seconds.`);
    delay = Math.min(delay * 2, 60_000);
    return wait(duration);
  }
  return { remaining, retry, finalReserve, elapsed: () => now() - start };
}

function publicationResult(context, manifest, log) {
  log(`Verified active MCP Registry entry for ${manifest.name}@${manifest.version}.`);
  return { attempts: context.attempts, elapsedMs: context.elapsed() };
}

async function finalRegistryCheck(context, manifest, log) {
  if (await inspectRegistry(context, manifest) === 'done') return publicationResult(context, manifest, log);
  throw new Error('MCP Registry publication was not verified within the recovery window. npm remains published; rerun only this registry workflow.');
}

async function inspectRegistry(context, manifest) {
  const record = await context.request('registry', context.version, Math.min(30_000, context.remaining()));
  if (record.status === 200) { assertRegistryRecord(record.data, manifest); return 'done'; }
  if (record.status === 404) return context.published ? 'waiting' : 'missing';
  if (transientStatus(record.status)) return 'waiting';
  throw new Error(`Registry verification returned HTTP ${record.status}.`);
}

function assertNpmMetadata(data, entry, manifest) {
  if (data?.name !== entry.identifier || data?.version !== entry.version || data?.mcpName !== manifest.name) {
    throw new Error('Published npm metadata does not match this release.');
  }
  if (!data.dist?.integrity || !data.dist?.tarball) throw new Error('Published npm metadata has no package artifact.');
}

async function preparePublish(context, entry, manifest) {
  const npm = await context.request('npm', context.version, Math.min(30_000, context.remaining()));
  if (npm.status === 404 || transientStatus(npm.status)) return 'exact npm version is not yet available';
  if (npm.status !== 200) throw new Error(`npm readiness check returned HTTP ${npm.status}.`);
  assertNpmMetadata(npm.data, entry, manifest);
  const login = await context.run(['login', 'github-oidc'], Math.min(60_000, context.remaining()));
  return loginFailure(login, entry);
}

function loginFailure(login, entry) {
  if (login.ok) return null;
  const reason = login.timedOut ? 'OIDC login timed out' : classifyPublishFailure(login.output, entry);
  if (reason && reason !== 'conflict') return reason;
  throw new Error('MCP Registry OIDC login failed. Check this workflow run and publishing permissions.');
}

async function publishAttempt(context, entry) {
  context.attempts++;
  const result = await context.run(['publish', context.manifestPath], Math.min(60_000, context.remaining()));
  if (result.ok) { context.published = true; return null; }
  const reason = result.timedOut ? 'publisher timed out; checking whether publication succeeded' : classifyPublishFailure(result.output, entry);
  if (!reason) throw new Error(`MCP Registry rejected publication: ${result.output.trim().slice(-4000)}`);
  if (reason === 'conflict') context.published = true;
  return reason;
}

export async function publishRegistry(manifest, pkg, options = {}) {
  const entry = validateManifest(manifest, pkg);
  const version = validateVersion(options.releaseVersion);
  if (manifest.version !== version) throw new Error('Release tag version does not match release metadata.');
  const { now = Date.now, wait = sleep, request = getJson, run = command, log = console.log, budgetMs = RECOVERY_MS, manifestPath = '.mcp/server.json' } = options;
  const recovery = createRecovery({ now, wait, log, budgetMs });
  const context = { ...recovery, request, run, version, manifestPath, attempts: 0, published: false };
  try {
    while (context.remaining() > context.finalReserve) {
      // Always reconcile before writing, including after a timeout or rerun.
      const status = await inspectRegistry(context, manifest);
      if (status === 'done') {
        return publicationResult(context, manifest, log);
      }
      const reason = status === 'waiting' ? 'registry entry is not yet readable' : await preparePublish(context, entry, manifest);
      if (reason) { await context.retry(reason); continue; }
      const failure = await publishAttempt(context, entry);
      if (failure) await context.retry(failure);
    }
    // Reserve time for readback instead of sleeping through the last deadline.
    return await finalRegistryCheck(context, manifest, log);
  } catch (error) {
    throw new Error(`Registry recovery stopped after ${context.elapsed()}ms: ${String(error)}`, { cause: error });
  }
}

function readReleaseFile(directory, name) {
  // Runner-owned metadata directory and fixed filenames; never loaded as code.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  return JSON.parse(readFileSync(join(directory, name), 'utf8'));
}

async function main() {
  const directory = process.env.RELEASE_METADATA_DIRECTORY;
  if (!directory) throw new Error('Release metadata directory is required.');
  const manifest = readReleaseFile(directory, 'server.json');
  const pkg = readReleaseFile(directory, 'package.json');
  const version = validateVersion(process.env.RELEASE_TAG?.slice(1));
  if (version !== manifest.version) throw new Error('Release tag version does not match release metadata.');
  if (process.argv[2] === '--validate') {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    validateRelease(event, process.env.GITHUB_REPOSITORY, manifest, pkg);
    return;
  }
  const result = await publishRegistry(manifest, pkg, { releaseVersion: version, manifestPath: join(directory, 'server.json') });
  if (process.env.GITHUB_STEP_SUMMARY) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Verified MCP Registry version **${manifest.version}** in ${Math.ceil(result.elapsedMs / 1000)} seconds (${result.attempts} publish attempts).\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
