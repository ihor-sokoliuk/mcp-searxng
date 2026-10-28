#!/usr/bin/env tsx

/**
 * Unit Tests: instance-discovery.ts
 *
 * Tests for searx.space feed parsing, instance ranking, cache behaviour, and
 * the runtime instance override. No network access: every fetch is injected.
 */

import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cacheAgeMs,
  discoveryCacheFile,
  fetchDiscoveryFeed,
  initializeInstanceDiscovery,
  isInstanceDiscoveryRequested,
  readDiscoveryCache,
  refreshDiscoveredInstancesIfExpired,
  resetInstanceDiscoveryForTests,
  resolveDiscoveredInstances,
  resolveDiscoveryOptions,
  selectInstances,
  startDiscoveryRefresh,
  writeDiscoveryCache,
  type DiscoveryFetcher,
  type DiscoveryOptions,
} from '../../src/instance-discovery.js';
import { setSearxngFetchForTesting } from '../../src/proxy.js';
import { getSearxngInstances, parseSearxngUrls } from '../../src/searxng-instances.js';
import { testFunction, createTestResults, printTestSummary } from '../helpers/test-utils.js';

const results = createTestResults();
const tempRoots: string[] = [];

function tempCacheFile(): string {
  const root = mkdtempSync(join(tmpdir(), 'mcp-searxng-discovery-'));
  tempRoots.push(root);
  return join(root, 'instances.json');
}

type FeedOptions = {
  status?: number;
  error?: string;
  analytics?: boolean;
  networkType?: string;
  searchPercent?: number;
  median?: number | null;
  engines?: number;
  httpScore?: number;
  version?: string;
};

const ENTRY_DEFAULTS: Required<Omit<FeedOptions, 'error' | 'median'>> & Pick<FeedOptions, 'error' | 'median'> = {
  networkType: 'normal',
  status: 200,
  analytics: false,
  searchPercent: 100,
  median: 1.5,
  engines: 5,
  httpScore: 100,
  version: '2026.10.27+abc',
};

function entry(overrides: FeedOptions = {}): Record<string, unknown> {
  const merged = { ...ENTRY_DEFAULTS, ...overrides };
  return {
    network_type: merged.networkType,
    analytics: merged.analytics,
    version: merged.version,
    http: { status_code: merged.status, error: merged.error ?? null, score: merged.httpScore },
    timing: {
      search: {
        success_percentage: merged.searchPercent,
        error: null,
        working_engines: merged.engines,
        all: merged.median === null ? null : { median: merged.median },
      },
    },
  };
}

function feed(entries: Record<string, Record<string, unknown>>): unknown {
  return { instances: entries };
}

const selectionOptions = { pool: 10, minSearchPercent: 90, maxMedianSeconds: 5 };

function discoveryOptions(cacheFile: string, overrides: Partial<DiscoveryOptions> = {}): DiscoveryOptions {
  return {
    feed: 'https://feed.test/instances.json',
    ttlMs: 86_400_000,
    pool: 10,
    minSearchPercent: 90,
    maxMedianSeconds: 5,
    timeoutMs: 1000,
    cacheFile,
    configured: [],
    ...overrides,
  };
}

function fetchReturning(payload: unknown): DiscoveryFetcher {
  return async () => payload;
}

function fetchFailing(message: string): DiscoveryFetcher {
  return async () => {
    throw new Error(message);
  };
}

async function runFlagAndSelectionTests() {
  await testFunction('isInstanceDiscoveryRequested reads SEARXNG_DISCOVERY and the URL sentinel', () => {
    assert.equal(isInstanceDiscoveryRequested({}), false);
    assert.equal(isInstanceDiscoveryRequested({ SEARXNG_DISCOVERY: 'searx.space' }), true);
    assert.equal(isInstanceDiscoveryRequested({ SEARXNG_DISCOVERY: ' SEARX.SPACE ' }), true);
    assert.equal(isInstanceDiscoveryRequested({ SEARXNG_DISCOVERY: 'false' }), false);
    assert.equal(isInstanceDiscoveryRequested({ SEARXNG_URL: 'searx.space' }), true);
    assert.equal(isInstanceDiscoveryRequested({ SEARXNG_URL: 'https://searx.space/' }), true);
    assert.equal(isInstanceDiscoveryRequested({ SEARXNG_URL: 'https://search.example.com' }), false);
    assert.equal(
      isInstanceDiscoveryRequested({ SEARXNG_URL: 'https://search.example.com', SEARXNG_DISCOVERY: 'searx.space' }),
      true,
    );
  }, results);

  await testFunction('selectInstances drops instances that cannot answer searches', () => {
    const selection = selectInstances(
      feed({
        'https://ok.example.com': entry(),
        'https://http-error.example.com': entry({ status: 500 }),
        'https://http-message.example.com': entry({ error: 'Connection refused' }),
        'https://analytics.example.com': entry({ analytics: true }),
        'https://tor.example.com': entry({ networkType: 'tor' }),
        'https://partial.example.com': entry({ searchPercent: 60 }),
        'https://slow.example.com': entry({ median: 9 }),
        'https://idle.example.com': entry({ engines: 0 }),
        'https://unknown-timing.example.com': entry({ median: null }),
        'http://insecure.example.com': entry(),
      }),
      selectionOptions,
    );

    assert.deepEqual(selection.instances, ['https://ok.example.com']);
    assert.equal(selection.total, 10);
    assert.equal(selection.eligible, 1);
  }, results);

  await testFunction('selectInstances prefers result coverage over raw latency', () => {
    const selection = selectInstances(
      feed({
        'https://fast-low-coverage.example.com': entry({ searchPercent: 100, engines: 2, median: 0.4 }),
        'https://full-coverage.example.com': entry({ searchPercent: 100, engines: 11, median: 2.4 }),
        'https://flaky.example.com': entry({ searchPercent: 92, engines: 20, median: 0.2 }),
      }),
      selectionOptions,
    );

    assert.deepEqual(selection.instances, [
      'https://full-coverage.example.com',
      'https://fast-low-coverage.example.com',
      'https://flaky.example.com',
    ]);
  }, results);

  await testFunction('selectInstances breaks ties by observatory score, latency, then version', () => {
    const selection = selectInstances(
      feed({
        'https://b-low-score.example.com': entry({ engines: 5, httpScore: 80, median: 0.5 }),
        'https://a-high-score.example.com': entry({ engines: 5, httpScore: 115, median: 3 }),
        'https://c-slowness.example.com': entry({ engines: 5, httpScore: 115, median: 4 }),
      }),
      selectionOptions,
    );

    assert.deepEqual(selection.instances, [
      'https://a-high-score.example.com',
      'https://c-slowness.example.com',
      'https://b-low-score.example.com',
    ]);
  }, results);

  await testFunction('selectInstances caps the pool and removes duplicate trailing slashes', () => {
    const selection = selectInstances(
      feed({
        'https://one.example.com/': entry(),
        'https://two.example.com': entry({ engines: 4 }),
        'https://three.example.com': entry({ engines: 3 }),
      }),
      { ...selectionOptions, pool: 2 },
    );

    assert.deepEqual(selection.instances, ['https://one.example.com', 'https://two.example.com']);
  }, results);

  await testFunction('selectInstances rejects a feed without an instances map', () => {
    assert.throws(() => selectInstances({}, selectionOptions), /no instances map/);
    assert.throws(() => selectInstances({ instances: {} }, selectionOptions), /no instances/);
  }, results);

}

async function runOptionsAndCacheTests() {
  await testFunction('resolveDiscoveryOptions applies defaults and warns once per invalid value', () => {
    const { options, warnings } = resolveDiscoveryOptions({ SEARXNG_DISCOVERY_CACHE: '/tmp/x.json' });
    assert.equal(options.feed, 'https://searx.space/data/instances.json');
    assert.equal(options.ttlMs, 86_400_000);
    assert.equal(options.pool, 10);
    assert.equal(options.minSearchPercent, 90);
    assert.equal(options.maxMedianSeconds, 5);
    assert.deepEqual(warnings, []);

    const invalid = resolveDiscoveryOptions({
      SEARXNG_DISCOVERY_CACHE: '/tmp/x.json',
      SEARXNG_DISCOVERY_POOL: '0',
      SEARXNG_DISCOVERY_MIN_SEARCH_PERCENT: '500',
    });
    assert.equal(invalid.options.pool, 10);
    assert.equal(invalid.options.minSearchPercent, 90);
    assert.equal(invalid.warnings.length, 2);
  }, results);

  await testFunction('resolveDiscoveryOptions rejects a non-http or credential-bearing feed', () => {
    const invalidScheme = resolveDiscoveryOptions({
      SEARXNG_DISCOVERY_CACHE: '/tmp/x.json',
      SEARXNG_DISCOVERY_FEED: 'file:///etc/passwd',
    });
    assert.equal(invalidScheme.options.feed, 'https://searx.space/data/instances.json');
    assert.equal(invalidScheme.warnings.length, 1);

    const withCredentials = resolveDiscoveryOptions({
      SEARXNG_DISCOVERY_CACHE: '/tmp/x.json',
      SEARXNG_DISCOVERY_FEED: 'https://user:pass@feed.test/instances.json',
    });
    assert.equal(withCredentials.options.feed, 'https://searx.space/data/instances.json');
    assert.equal(withCredentials.warnings.length, 1);

    const valid = resolveDiscoveryOptions({
      SEARXNG_DISCOVERY_CACHE: '/tmp/x.json',
      SEARXNG_DISCOVERY_FEED: 'https://mirror.test/instances.json',
    });
    assert.equal(valid.options.feed, 'https://mirror.test/instances.json');
    assert.deepEqual(valid.warnings, []);
  }, results);

  await testFunction('cache round-trips and reports its age', () => {
    const file = tempCacheFile();
    assert.equal(readDiscoveryCache(file), null);

    writeDiscoveryCache(file, {
      fetchedAt: new Date(Date.now() - 60_000).toISOString(),
      feed: 'https://feed.test/instances.json',
      instances: ['https://one.example.com'],
      total: 4,
      eligible: 1,
    });

    const cache = readDiscoveryCache(file);
    assert.ok(cache);
    assert.deepEqual(cache.instances, ['https://one.example.com']);
    assert.equal(cache.total, 4);
    assert.ok(cacheAgeMs(cache) >= 55_000);
  }, results);

  await testFunction('a fresh cache applies the current pool size instead of the cached slice', async () => {
    const file = tempCacheFile();
    writeDiscoveryCache(file, {
      fetchedAt: new Date().toISOString(),
      feed: 'https://feed.test/instances.json',
      instances: ['https://one.example.com', 'https://two.example.com', 'https://three.example.com'],
      total: 3,
      eligible: 3,
    });

    const fresh = await resolveDiscoveredInstances(discoveryOptions(file, { pool: 2 }));
    assert.deepEqual(fresh.instances, ['https://one.example.com', 'https://two.example.com']);

    const wider = await resolveDiscoveredInstances(discoveryOptions(file, { pool: 3 }));
    assert.equal(wider.instances.length, 3);
  }, results);

  await testFunction('resolveDiscoveredInstances serves a fresh cache without fetching', async () => {
    const file = tempCacheFile();
    writeDiscoveryCache(file, {
      fetchedAt: new Date().toISOString(),
      feed: 'https://feed.test/instances.json',
      instances: ['https://cached.example.com'],
      total: 2,
      eligible: 1,
    });

    let calls = 0;
    const fetchImpl: DiscoveryFetcher = async () => {
      calls += 1;
      return {};
    };

    const result = await resolveDiscoveredInstances(discoveryOptions(file, { fetchImpl }));
    assert.equal(result.origin, 'cache');
    assert.deepEqual(result.instances, ['https://cached.example.com']);
    assert.equal(calls, 0);
  }, results);

  await testFunction('resolveDiscoveredInstances refreshes an expired cache and stores the result', async () => {
    const file = tempCacheFile();
    writeDiscoveryCache(file, {
      fetchedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
      feed: 'https://feed.test/instances.json',
      instances: ['https://old.example.com'],
      total: 2,
      eligible: 1,
    });

    const payload = feed({
      'https://fresh.example.com': entry(),
      'https://second.example.com': entry({ engines: 3 }),
    });
    const result = await resolveDiscoveredInstances(
      discoveryOptions(file, { fetchImpl: fetchReturning(payload) }),
    );

    assert.equal(result.origin, 'refreshed');
    assert.deepEqual(result.instances, ['https://fresh.example.com', 'https://second.example.com']);
    assert.deepEqual(readDiscoveryCache(file)?.instances, result.instances);
  }, results);

  await testFunction('resolveDiscoveredInstances falls back to a stale cache when the feed fails', async () => {
    const file = tempCacheFile();
    writeDiscoveryCache(file, {
      fetchedAt: new Date(Date.now() - 5 * 86_400_000).toISOString(),
      feed: 'https://feed.test/instances.json',
      instances: ['https://stale.example.com'],
      total: 3,
      eligible: 1,
    });

    const result = await resolveDiscoveredInstances(
      discoveryOptions(file, { fetchImpl: fetchFailing('feed offline') }),
    );

    assert.equal(result.origin, 'stale-cache');
    assert.deepEqual(result.instances, ['https://stale.example.com']);
    assert.ok(result.cacheAgeMs >= 4 * 86_400_000);
  }, results);

  await testFunction('resolveDiscoveredInstances rethrows when the feed fails and no cache exists', async () => {
    const file = tempCacheFile();
    await assert.rejects(
      resolveDiscoveredInstances(discoveryOptions(file, { fetchImpl: fetchFailing('feed offline') })),
      /feed offline/,
    );
  }, results);

}

async function runStartupTests() {
  await testFunction('initializeInstanceDiscovery installs the discovered list as the active instances', async () => {
    resetInstanceDiscoveryForTests();
    const file = tempCacheFile();
    writeDiscoveryCache(file, {
      fetchedAt: new Date().toISOString(),
      feed: 'https://searx.space/data/instances.json',
      instances: ['https://discovered.example.com'],
      total: 1,
      eligible: 1,
    });

    const env = {
      SEARXNG_DISCOVERY: 'searx.space',
      SEARXNG_DISCOVERY_CACHE: file,
    };

    assert.equal(await initializeInstanceDiscovery(env), true);
    assert.deepEqual(getSearxngInstances(), ['https://discovered.example.com']);

    resetInstanceDiscoveryForTests();
  }, results);

  await testFunction('initializeInstanceDiscovery keeps configured instances ahead of discovered ones', async () => {
    resetInstanceDiscoveryForTests();
    const file = tempCacheFile();
    writeDiscoveryCache(file, {
      fetchedAt: new Date().toISOString(),
      feed: 'https://searx.space/data/instances.json',
      instances: ['https://discovered.example.com'],
      total: 1,
      eligible: 1,
    });

    const ok = await initializeInstanceDiscovery({
      SEARXNG_DISCOVERY: 'searx.space',
      SEARXNG_URL: 'https://mine.example.com;https://backup.example.com',
      SEARXNG_DISCOVERY_CACHE: file,
    });

    assert.equal(ok, true);
    assert.deepEqual(getSearxngInstances(), [
      'https://mine.example.com',
      'https://backup.example.com',
      'https://discovered.example.com',
    ]);
    resetInstanceDiscoveryForTests();
  }, results);

  await testFunction('initializeInstanceDiscovery drops the searx.space sentinel from the replica list', async () => {
    resetInstanceDiscoveryForTests();
    const file = tempCacheFile();
    writeDiscoveryCache(file, {
      fetchedAt: new Date().toISOString(),
      feed: 'https://searx.space/data/instances.json',
      instances: ['https://discovered.example.com'],
      total: 1,
      eligible: 1,
    });

    assert.equal(
      await initializeInstanceDiscovery({ SEARXNG_URL: 'searx.space', SEARXNG_DISCOVERY_CACHE: file }),
      true,
    );
    assert.deepEqual(getSearxngInstances(), ['https://discovered.example.com']);
    resetInstanceDiscoveryForTests();
  }, results);

  await testFunction('initializeInstanceDiscovery leaves SEARXNG_URL alone when discovery is off', async () => {
    resetInstanceDiscoveryForTests();
    assert.equal(await initializeInstanceDiscovery({}), false);
    const previous = process.env.SEARXNG_URL;
    process.env.SEARXNG_URL = 'https://configured.example.com';
    try {
      assert.deepEqual(getSearxngInstances(), ['https://configured.example.com']);
    } finally {
      if (previous === undefined) {
        delete process.env.SEARXNG_URL;
      } else {
        process.env.SEARXNG_URL = previous;
      }
      resetInstanceDiscoveryForTests();
    }
  }, results);

}

async function runRefreshAndFetchTests() {
  await testFunction('fetchDiscoveryFeed returns the parsed payload and rejects HTTP errors', async () => {
    try {
      setSearxngFetchForTesting(async () =>
        new Response(JSON.stringify(feed({ 'https://ok.example.com': entry() })), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }) as unknown as Response);
      const payload = await fetchDiscoveryFeed('https://feed.test/instances.json', 1000);
      assert.ok(payload && typeof payload === 'object');

      setSearxngFetchForTesting(async () =>
        new Response('nope', { status: 503, statusText: 'Service Unavailable' }) as unknown as Response);
      await assert.rejects(fetchDiscoveryFeed('https://feed.test/instances.json', 1000), /503 Service Unavailable/);
    } finally {
      setSearxngFetchForTesting();
    }
  }, results);

  await testFunction('discoveryCacheFile honours the explicit setting, XDG_CACHE_HOME, and the prefix', () => {
    assert.equal(discoveryCacheFile({ SEARXNG_DISCOVERY_CACHE: '/tmp/explicit.json' }), '/tmp/explicit.json');
    assert.equal(
      discoveryCacheFile({ XDG_CACHE_HOME: '/tmp/xdg-root' }),
      join('/tmp/xdg-root', 'mcp-searxng', 'instances.json'),
    );
    assert.ok(discoveryCacheFile({}).endsWith(join('mcp-searxng', 'instances.json')));
  }, results);

  await testFunction('readDiscoveryCache ignores malformed and empty caches', () => {
    const file = tempCacheFile();
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- isolated temporary test fixture
    writeFileSync(file, 'not json');
    assert.equal(readDiscoveryCache(file), null);

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- isolated temporary test fixture
    writeFileSync(file, JSON.stringify({ fetchedAt: new Date().toISOString(), instances: [] }));
    assert.equal(readDiscoveryCache(file), null);
  }, results);

  await testFunction('startDiscoveryRefresh installs one background timer at a time', async () => {
    const file = tempCacheFile();
    const options = discoveryOptions(file);
    const first = startDiscoveryRefresh(options);
    const second = startDiscoveryRefresh(options);
    assert.equal(typeof second.unref, 'function');
    assert.notEqual(first, second);
    resetInstanceDiscoveryForTests();
  }, results);

  await testFunction('refreshDiscoveredInstancesIfExpired skips a fresh cache and replaces an expired one', async () => {
    const file = tempCacheFile();
    writeDiscoveryCache(file, {
      fetchedAt: new Date().toISOString(),
      feed: 'https://feed.test/instances.json',
      instances: ['https://cached.example.com'],
      total: 1,
      eligible: 1,
    });

    assert.equal(await refreshDiscoveredInstancesIfExpired(discoveryOptions(file)), false);

    const payload = feed({ 'https://next.example.com': entry() });
    const refreshed = await refreshDiscoveredInstancesIfExpired(
      discoveryOptions(file, { ttlMs: 0, fetchImpl: fetchReturning(payload) }),
    );
    assert.equal(refreshed, true);
    assert.deepEqual(getSearxngInstances(), ['https://next.example.com']);
    resetInstanceDiscoveryForTests();
  }, results);

  await testFunction('refreshDiscoveredInstancesIfExpired keeps configured instances ahead of refreshed ones', async () => {
    const file = tempCacheFile();
    writeDiscoveryCache(file, {
      fetchedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
      feed: 'https://feed.test/instances.json',
      instances: ['https://old.example.com'],
      total: 1,
      eligible: 1,
    });

    const refreshed = await refreshDiscoveredInstancesIfExpired(
      discoveryOptions(file, {
        configured: ['https://mine.example.com'],
        fetchImpl: fetchReturning(feed({ 'https://new.example.com': entry() })),
      }),
    );

    assert.equal(refreshed, true);
    assert.deepEqual(getSearxngInstances(), ['https://mine.example.com', 'https://new.example.com']);
    resetInstanceDiscoveryForTests();
  }, results);

  await testFunction('refreshDiscoveredInstancesIfExpired keeps the list when the feed fails', async () => {
    const file = tempCacheFile();
    resetInstanceDiscoveryForTests();
    const refreshed = await refreshDiscoveredInstancesIfExpired(
      discoveryOptions(file, { fetchImpl: fetchFailing('feed offline') }),
    );
    assert.equal(refreshed, false);
    assert.deepEqual(getSearxngInstances(), parseSearxngUrls());
  }, results);

  await testFunction('initializeInstanceDiscovery reports false when the feed is unreachable and no cache exists', async () => {
    resetInstanceDiscoveryForTests();
    const file = tempCacheFile();
    const ok = await initializeInstanceDiscovery({
      SEARXNG_DISCOVERY: 'searx.space',
      SEARXNG_DISCOVERY_CACHE: file,
      SEARXNG_DISCOVERY_FEED: 'http://127.0.0.1:1/instances.json',
      SEARXNG_DISCOVERY_TIMEOUT_MS: '1000',
    });

    assert.equal(ok, false);
    assert.equal(readDiscoveryCache(file), null);
    assert.deepEqual(getSearxngInstances(), parseSearxngUrls());
    resetInstanceDiscoveryForTests();
  }, results);

  console.log('\n');
}

async function runTests() {
  console.log('🧪 Testing: instance-discovery.ts\n');

  await runFlagAndSelectionTests();
  await runOptionsAndCacheTests();
  await runStartupTests();
  await runRefreshAndFetchTests();

  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true });
  }

  printTestSummary(results, 'Instance Discovery');
  return results;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  runTests().then(results => {
    process.exit(results.failed > 0 ? 1 : 0);
  }).catch(console.error);
}

export { runTests };
