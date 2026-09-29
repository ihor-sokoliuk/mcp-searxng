import { execFile } from 'node:child_process';
import { readFileSync, appendFileSync } from 'node:fs';
import { isDeepStrictEqual, promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const execute = promisify(execFile);
export const RECOVERY_MS = 15 * 60 * 1000;
const REGISTRY = 'https://registry.modelcontextprotocol.io/v0.1/servers/';
const NETWORK_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET']);

export function validateManifest(manifest, pkg) {
  const [core, ...suffix] = String(pkg.version).split('-');
  if (!/^\d+\.\d+\.\d+$/.test(core) || (suffix.length > 0 && !/^[\w.-]+$/.test(suffix.join('-')))
      || manifest.version !== pkg.version || manifest.name !== pkg.mcpName
      || manifest.repository?.url !== pkg.repository?.url
      || manifest.packages?.length !== 1) throw new Error('Release metadata does not match package.json.');
  const entry = manifest.packages[0];
  if (entry.registryType !== 'npm' || entry.identifier !== pkg.name || entry.version !== pkg.version) {
    throw new Error('Expected exactly one npm package at the release version.');
  }
  return entry;
}

export function validateRelease(event, repository, manifest, pkg) {
  validateManifest(manifest, pkg);
  const run = event.workflow_run;
  if (run?.conclusion !== 'success' || run.event !== 'push'
      || run.path !== '.github/workflows/npm-publish.yml'
      || run.head_repository?.full_name !== repository
      || manifest.repository.url !== `https://github.com/${repository}`
      || run.head_branch !== `v${manifest.version}` || !/^[a-f0-9]{40}$/.test(run.head_sha)) {
    throw new Error('Registry publication requires a successful npm release run from this repository and exact version tag.');
  }
}

export function transientStatus(status) {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

export function classifyPublishFailure(output, entry) {
  const status = Number(output.match(/server returned status (\d{3})\b/)?.[1]);
  if (status === 409) return 'conflict';
  if (transientStatus(status)) return 'temporary registry response';
  // HTTP 400 generally means invalid metadata. Retry only this exact upstream
  // validation failure for the package/version we just published to npm.
  if (status === 400 && output.includes('registry validation failed for package')
      && output.includes(`NPM package '${entry.identifier}' exists, but version '${entry.version}' was not found (status: 404)`)) {
    return 'npm version is not yet visible to MCP Registry';
  }
  if (!status && /connection reset by peer|connection refused|i\/o timeout|TLS handshake timeout|context deadline exceeded|temporary failure in name resolution/i.test(output)) {
    return 'temporary network failure';
  }
  return null;
}

async function getJson(url, timeoutMs) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
    if (!response.ok) {
      await response.body?.cancel();
      return { status: response.status };
    }
    return { status: response.status, data: await response.json() };
  } catch (error) {
    if (error.name === 'TimeoutError' || NETWORK_CODES.has(error.cause?.code ?? error.code)) return { status: 503 };
    throw error;
  }
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

function assertRegistryRecord(data, manifest) {
  const expected = { name: manifest.name, version: manifest.version, repository: manifest.repository, packages: normalizePackages(manifest.packages) };
  const actual = data?.server;
  if (!actual || !isDeepStrictEqual(expected, { name: actual.name, version: actual.version, repository: actual.repository, packages: normalizePackages(actual.packages) })
      || data?._meta?.['io.modelcontextprotocol.registry/official']?.status !== 'active') {
    throw new Error('Existing registry version does not match the expected active release; refusing to overwrite it.');
  }
}

export async function publishRegistry(manifest, pkg, overrides = {}) {
  const entry = validateManifest(manifest, pkg);
  const { now = Date.now, wait = sleep, request = getJson, run = command, log = console.log, budgetMs = RECOVERY_MS } = overrides;
  const start = now();
  const deadline = start + budgetMs;
  const remaining = () => {
    const value = deadline - now();
    if (value <= 0) throw new Error('MCP Registry publication was not verified within the recovery window. npm remains published; rerun only this registry workflow.');
    return value;
  };
  const requestTimeout = () => Math.min(30_000, remaining());
  const commandTimeout = () => Math.min(60_000, remaining());
  let delay = 10_000;
  let published = false;
  let attempts = 0;
  async function retry(reason) {
    const duration = Math.min(delay, remaining());
    log(`Waiting: ${reason}. Checking again in ${Math.ceil(duration / 1000)} seconds.`);
    await wait(duration);
    delay = Math.min(delay * 2, 60_000);
  }
  const recordUrl = `${REGISTRY}${encodeURIComponent(manifest.name)}/versions/${encodeURIComponent(manifest.version)}`;
  const npmUrl = `https://registry.npmjs.org/${encodeURIComponent(entry.identifier)}/${encodeURIComponent(entry.version)}`;
  while (remaining() > 0) {
    // Reconcile before every write, including after a timeout or a rerun.
    const record = await request(recordUrl, requestTimeout());
    if (record.status === 200) {
      assertRegistryRecord(record.data, manifest);
      log(`Verified active MCP Registry entry for ${manifest.name}@${manifest.version}.`);
      return { attempts, elapsedMs: now() - start };
    }
    if (record.status !== 404 && !transientStatus(record.status)) throw new Error(`Registry verification returned HTTP ${record.status}.`);
    if (published || record.status !== 404) { await retry('registry entry is not yet readable'); continue; }

    const npm = await request(npmUrl, requestTimeout());
    if (npm.status === 404 || transientStatus(npm.status)) { await retry('exact npm version is not yet available'); continue; }
    if (npm.status !== 200) throw new Error(`npm readiness check returned HTTP ${npm.status}.`);
    if (npm.data?.name !== entry.identifier || npm.data?.version !== entry.version || npm.data?.mcpName !== manifest.name
        || !npm.data?.dist?.integrity || !npm.data?.dist?.tarball) throw new Error('Published npm metadata does not match this release.');

    // Obtain fresh credentials after any readiness wait, avoiding token expiry.
    const login = await run(['login', 'github-oidc'], commandTimeout());
    if (!login.ok) {
      const reason = login.timedOut ? 'OIDC login timed out' : classifyPublishFailure(login.output, entry);
      if (reason && reason !== 'conflict') { await retry(reason); continue; }
      throw new Error('MCP Registry OIDC login failed. Check this workflow run and publishing permissions.');
    }
    attempts++;
    const result = await run(['publish', '.mcp/server.json'], commandTimeout());
    if (result.ok) { published = true; continue; }
    const failure = result.timedOut ? 'publisher timed out; checking whether publication succeeded' : classifyPublishFailure(result.output, entry);
    if (!failure) throw new Error(`MCP Registry rejected publication: ${result.output.trim().slice(-4000)}`);
    // A conflict may mean a previous attempt succeeded: read back, never blindly
    // treat an existing version as success or repeatedly submit a duplicate.
    if (failure === 'conflict') published = true;
    await retry(failure);
  }
}

async function main() {
  const manifest = JSON.parse(readFileSync('.mcp/server.json', 'utf8'));
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  if (process.argv[2] === '--validate') {
    // GitHub supplies this runner-owned path, not issue/PR input.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    validateRelease(event, process.env.GITHUB_REPOSITORY, manifest, pkg);
    return;
  }
  const result = await publishRegistry(manifest, pkg);
  if (process.env.GITHUB_STEP_SUMMARY) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Verified MCP Registry version **${manifest.version}** in ${Math.ceil(result.elapsedMs / 1000)} seconds (${result.attempts} publish attempts).\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
