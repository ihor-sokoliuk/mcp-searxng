import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { classifyPublishFailure, publishRegistry, RECOVERY_MS, validateRelease } from './publish-mcp-registry.mjs';

const pkg = { name: 'mcp-example', version: '2.5.0', mcpName: 'io.github.owner/example', repository: { url: 'https://github.com/owner/example' } };
const manifest = { name: pkg.mcpName, version: pkg.version, repository: pkg.repository, packages: [{ registryType: 'npm', identifier: pkg.name, version: pkg.version, transport: { type: 'stdio' } }] };
const npm = { status: 200, data: { ...pkg, dist: { integrity: 'sha512-fixture', tarball: 'https://registry.npmjs.org/mcp-example/-/mcp-example-2.5.0.tgz' } } };
const record = { status: 200, data: { server: manifest, _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active' } } } };
const missing = { status: 404 };
const success = { ok: true, output: '' };
const propagation = { ok: false, output: `Error: publish failed: server returned status 400: {"errors":[{"message":"registry validation failed for package 0 (mcp-example): NPM package 'mcp-example' exists, but version '2.5.0' was not found (status: 404)."}]}` };
const event = { workflow_run: { conclusion: 'success', event: 'push', path: '.github/workflows/npm-publish.yml', head_repository: { full_name: 'owner/example' }, head_branch: 'v2.5.0', head_sha: 'a'.repeat(40) } };

function harness({ records = [missing, record], packages = [npm], results = [success], login = success, budgetMs = RECOVERY_MS } = {}) {
  let time = 0;
  const waits = [], calls = [], logs = [], timeouts = [];
  const next = queue => queue.length > 1 ? queue.shift() : queue[0];
  return {
    waits, calls, logs, timeouts,
    run: () => publishRegistry(manifest, pkg, {
      budgetMs, now: () => time, wait: async ms => { waits.push(ms); time += ms; }, log: line => logs.push(line),
      request: async (url, timeout) => { calls.push(url); timeouts.push(timeout); return next(url.startsWith('https://registry.npmjs.org/') ? packages : records); },
      run: async (args, timeout) => { calls.push(args[0]); timeouts.push(timeout); return args[0] === 'login' ? (Array.isArray(login) ? next(login) : login) : next(results); },
    }),
  };
}

test('fast success has no mandatory wait and verifies after publishing', async () => {
  const h = harness();
  assert.deepEqual(await h.run(), { attempts: 1, elapsedMs: 0 });
  assert.deepEqual(h.waits, []);
  assert.deepEqual(h.calls.map(c => c.startsWith('https:') ? new URL(c).hostname : c), [
    'registry.modelcontextprotocol.io', 'registry.npmjs.org', 'login', 'publish', 'registry.modelcontextprotocol.io',
  ]);
});

test('npm propagation waits before obtaining credentials or publishing', async () => {
  const h = harness({ records: [missing, missing, record], packages: [missing, npm] });
  assert.deepEqual(await h.run(), { attempts: 1, elapsedMs: 10_000 });
  assert.equal(h.calls.filter(x => x === 'publish').length, 1);
  assert.match(h.logs[0], /exact npm version/);
});

test('registry-side npm 404 inside HTTP 400 recovers in the same invocation', async () => {
  const h = harness({ records: [missing, missing, record], results: [propagation, success] });
  assert.deepEqual(await h.run(), { attempts: 2, elapsedMs: 10_000 });
  assert.match(h.logs[0], /not yet visible to MCP Registry/);
});

test('published but not yet readable is polled without a second write', async () => {
  const h = harness({ records: [missing, missing, missing, record] });
  assert.deepEqual(await h.run(), { attempts: 1, elapsedMs: 30_000 });
  assert.deepEqual(h.waits, [10_000, 20_000]);
});

test('already published exact version is verified without credentials or a write', async () => {
  const h = harness({ records: [record] });
  assert.equal((await h.run()).attempts, 0);
  assert.equal(h.calls.length, 1);
});

test('ambiguous timeout is reconciled before any repeat publication', async () => {
  const h = harness({ results: [{ ok: false, timedOut: true, output: '' }] });
  assert.equal((await h.run()).attempts, 1);
  assert.equal(h.calls.filter(x => x === 'publish').length, 1);
});

test('HTTP 409 requires matching readback rather than assuming success', async () => {
  const h = harness({ records: [missing, missing, record], results: [{ ok: false, output: 'server returned status 409: version already exists' }] });
  assert.equal((await h.run()).attempts, 1);
  assert.deepEqual(h.waits, [10_000, 20_000]);
});

test('mismatched or inactive existing record fails without modifying it', async () => {
  for (const change of [
    data => { data.server.packages[0].version = '2.4.0'; },
    data => { data.server.name = 'other/server'; },
    data => { data._meta['io.modelcontextprotocol.registry/official'].status = 'deprecated'; },
  ]) {
    const changed = structuredClone(record); change(changed.data);
    const h = harness({ records: [changed] });
    await assert.rejects(h.run(), /does not match/);
    assert.equal(h.calls.length, 1);
  }
});

test('registry omission of false environment defaults preserves semantic equality', async () => {
  const source = structuredClone(manifest);
  source.packages[0].environmentVariables = [{ name: 'OPTIONAL', isRequired: false, isSecret: false }];
  const serialized = structuredClone(record);
  serialized.data.server = structuredClone(source);
  serialized.data.server.packages[0].environmentVariables = [{ name: 'OPTIONAL' }];
  const options = { request: async () => serialized, run: async () => assert.fail('Must not publish an existing entry'), log: () => {} };
  assert.equal((await publishRegistry(source, pkg, options)).attempts, 0);
  serialized.data.server.packages[0].environmentVariables[0].isRequired = true;
  await assert.rejects(publishRegistry(source, pkg, options), /does not match/);
});

test('retries 429 and server errors, but fails permanent HTTP responses promptly', async () => {
  for (const status of [408, 429, 500, 502, 503, 504]) {
    const h = harness({ records: [{ status }, missing, record] });
    assert.equal((await h.run()).attempts, 1);
    assert.deepEqual(h.waits, [10_000]);
  }
  for (const status of [400, 401, 403]) {
    const h = harness({ records: [{ status }] });
    await assert.rejects(h.run(), error => error.message.includes(`HTTP ${status}`));
    assert.deepEqual(h.waits, []);
  }
});

test('invalid metadata, authentication and unrelated 400 errors do not retry', async () => {
  for (const output of ['server returned status 400: invalid schema', 'server returned status 401: unauthorized', 'server returned status 403: forbidden', propagation.output.replace('2.5.0', '2.4.0')]) {
    const h = harness({ results: [{ ok: false, output }] });
    await assert.rejects(h.run(), /rejected publication/);
    assert.deepEqual(h.waits, []);
  }
  const h = harness({ login: { ok: false, output: 'unauthorized' } });
  await assert.rejects(h.run(), /OIDC login failed/);
  assert.equal(h.calls.includes('publish'), false);
});

test('incorrect npm release identity never reaches publisher', async () => {
  for (const field of ['name', 'version', 'mcpName']) {
    const changed = structuredClone(npm);
    // The keys above are a fixed test fixture list.
    // eslint-disable-next-line security/detect-object-injection
    changed.data[field] = 'wrong';
    const h = harness({ packages: [changed] });
    await assert.rejects(h.run(), /npm metadata/);
    assert.equal(h.calls.includes('login'), false);
  }
});

test('temporary login failure recovers without premature publication', async () => {
  const h = harness({ records: [missing, missing, record], login: [{ ok: false, output: 'server returned status 503: temporarily unavailable' }, success] });
  assert.deepEqual(await h.run(), { attempts: 1, elapsedMs: 10_000 });
  assert.equal(h.calls.filter(x => x === 'login').length, 2);
});

test('one bounded budget covers all waits; failed propagation never publishes', async () => {
  const h = harness({ records: [missing], packages: [missing] });
  await assert.rejects(h.run(), /within the recovery window/);
  assert.equal(h.waits.reduce((a, b) => a + b, 0), RECOVERY_MS);
  assert.ok(h.waits.every(ms => ms <= 60_000));
  assert.equal(h.calls.includes('publish'), false);
  assert.ok(h.timeouts.every(ms => ms > 0 && ms <= 30_000));
});

test('mixed readiness and publishing failures share the same budget', async () => {
  const h = harness({ records: [missing], packages: [missing, npm], results: [propagation], budgetMs: 25_000 });
  await assert.rejects(h.run(), /within the recovery window/);
  assert.deepEqual(h.waits, [10_000, 15_000]);
  assert.equal(h.calls.filter(x => x === 'publish').length, 1);
  assert.ok(h.timeouts.at(-1) <= 15_000);
});

test('publisher classifies only specific propagation and transient failures', () => {
  assert.ok(classifyPublishFailure(propagation.output, manifest.packages[0]));
  for (const output of ['server returned status 503: temporarily unavailable', 'dial tcp: i/o timeout', 'connection reset by peer']) assert.ok(classifyPublishFailure(output, manifest.packages[0]));
  for (const output of ['bad JSON', 'certificate signed by unknown authority', 'server returned status 400: missing description']) assert.equal(classifyPublishFailure(output, manifest.packages[0]), null);
});

test('only the successful same-repository tag release is accepted', () => {
  assert.doesNotThrow(() => validateRelease(event, 'owner/example', manifest, pkg));
  for (const change of [
    run => { run.event = 'pull_request'; },
    run => { run.conclusion = 'failure'; },
    run => { run.head_repository.full_name = 'fork/example'; },
    run => { run.head_branch = 'main'; },
    run => { run.head_branch = 'v2.4.0'; },
    run => { run.head_sha = 'main'; },
    run => { run.path = '.github/workflows/ci.yml'; },
  ]) {
    const changed = structuredClone(event); change(changed.workflow_run);
    assert.throws(() => validateRelease(changed, 'owner/example', manifest, pkg), /requires a successful npm release/);
  }
  assert.throws(() => validateRelease(event, 'owner/example', { ...manifest, version: '2.4.0' }, pkg), /metadata/);
});

test('workflow wiring keeps publication isolated and checks out the triggering commit', () => {
  // Both URLs are constant paths relative to this test file.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const source = readFileSync(new URL('../.github/workflows/mcp-registry-publish.yml', import.meta.url), 'utf8');
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const upstream = readFileSync(new URL('../.github/workflows/npm-publish.yml', import.meta.url), 'utf8');
  assert.match(source, /workflow_run:\s+workflows: \[Publish NPM Package\]\s+types: \[completed\]/);
  assert.match(source, /ref: \$\{\{ github.event.workflow_run.head_sha \}\}/);
  assert.match(source, /conclusion == 'success'/);
  assert.match(source, /head_repository.full_name == github.repository/);
  assert.match(source, /node scripts\/publish-mcp-registry.mjs --validate/);
  assert.doesNotMatch(source, /workflow_dispatch:|npm publish|continue-on-error/);
  assert.doesNotMatch(upstream, /publish-mcp-registry:|mcp-publisher publish/);
});
