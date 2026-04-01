# Security Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Raise the minimum safe `undici` version and add an opt-in hardened HTTP profile without breaking existing customer deployments by default.

**Architecture:** Keep current runtime behavior as the compatibility baseline, then layer hardening behind explicit HTTP environment variables. Isolate the new behavior behind focused configuration and policy helpers so `http-server.ts`, `url-reader.ts`, and `resources.ts` stay readable and testable.

**Tech Stack:** TypeScript, Node.js 20+, Express 5, `@modelcontextprotocol/sdk`, Undici, existing `tsx` test harness with `supertest`

---

### Task 1: Raise The Safe Undici Floor

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Test: dependency audit output from `npm audit --json`

- [ ] **Step 1: Update the declared `undici` range in `package.json`**

Replace the dependency entry so the manifest no longer advertises vulnerable 7.x releases:

```json
"dependencies": {
  "@modelcontextprotocol/sdk": "1.29.0",
  "@types/cors": "^2.8.19",
  "@types/express": "^5.0.6",
  "cors": "^2.8.6",
  "express": "^5.2.1",
  "node-html-markdown": "^2.0.0",
  "undici": "^7.24.0"
}
```

- [ ] **Step 2: Refresh the lockfile**

Run:

```bash
npm install
```

Expected:
- `package-lock.json` updates
- installed `undici` resolves to `7.24.x` or newer
- no dependency installation errors

- [ ] **Step 3: Verify the installed top-level dependency**

Run:

```bash
npm ls --depth=0
```

Expected output includes a line like:

```text
undici@7.24.x
```

- [ ] **Step 4: Re-run vulnerability verification**

Run:

```bash
npm audit --json
```

Expected:

```json
{
  "metadata": {
    "vulnerabilities": {
      "total": 0
    }
  }
}
```

- [ ] **Step 5: Commit the dependency floor update**

Run:

```bash
git add package.json package-lock.json
git commit -m "fix: raise undici minimum safe version"
```

### Task 2: Add HTTP Hardening Configuration And Enforcement

**Files:**
- Create: `src/http-security.ts`
- Modify: `src/http-server.ts`
- Test: `__tests__/integration/http-server.test.ts`
- Test: `__tests__/unit/http-security.test.ts`

- [ ] **Step 1: Add a failing unit test file for HTTP hardening configuration**

Create `__tests__/unit/http-security.test.ts` with coverage for default mode and hardened mode config parsing:

```ts
#!/usr/bin/env tsx

import { strict as assert } from 'node:assert';
import {
  getHttpSecurityConfig,
  isRequestAuthorized,
  isOriginAllowed,
} from '../../src/http-security.js';
import { testFunction, createTestResults, printTestSummary } from '../helpers/test-utils.js';
import { EnvManager } from '../helpers/env-utils.js';

const results = createTestResults();
const envManager = new EnvManager();

async function runTests() {
  await testFunction('default config preserves compatibility mode', () => {
    envManager.delete('MCP_HTTP_HARDEN');
    envManager.delete('MCP_HTTP_AUTH_TOKEN');
    envManager.delete('MCP_HTTP_ALLOWED_ORIGINS');

    const config = getHttpSecurityConfig();
    assert.equal(config.harden, false);
    assert.equal(config.requireAuth, false);
    assert.equal(config.restrictOrigins, false);

    envManager.restore();
  }, results);

  await testFunction('hardened mode requires token and restricted origins', () => {
    envManager.set('MCP_HTTP_HARDEN', 'true');
    envManager.set('MCP_HTTP_AUTH_TOKEN', 'secret-token');
    envManager.set('MCP_HTTP_ALLOWED_ORIGINS', 'https://app.example.com,https://admin.example.com');

    const config = getHttpSecurityConfig();
    assert.equal(config.harden, true);
    assert.equal(config.requireAuth, true);
    assert.deepEqual(config.allowedOrigins, [
      'https://app.example.com',
      'https://admin.example.com',
    ]);

    envManager.restore();
  }, results);

  await testFunction('authorization passes in compatibility mode', () => {
    const config = { harden: false, requireAuth: false } as any;
    assert.equal(isRequestAuthorized(undefined, config), true);
  }, results);

  await testFunction('authorization rejects missing token in hardened mode', () => {
    const config = { harden: true, requireAuth: true, authToken: 'secret-token' } as any;
    assert.equal(isRequestAuthorized(undefined, config), false);
  }, results);

  await testFunction('origin allowlist rejects unknown origins in hardened mode', () => {
    const config = {
      harden: true,
      restrictOrigins: true,
      allowedOrigins: ['https://app.example.com'],
    } as any;
    assert.equal(isOriginAllowed('https://evil.example.com', config), false);
    assert.equal(isOriginAllowed('https://app.example.com', config), true);
  }, results);

  printTestSummary(results, 'HTTP Security');
  return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runTests().then(results => process.exit(results.failed > 0 ? 1 : 0)).catch(console.error);
}

export { runTests };
```

- [ ] **Step 2: Run the new test and confirm it fails**

Run:

```bash
tsx __tests__/unit/http-security.test.ts
```

Expected:

```text
Error: Cannot find module '../../src/http-security.js'
```

- [ ] **Step 3: Implement the HTTP security helper module**

Create `src/http-security.ts` with config parsing and request-policy helpers:

```ts
export interface HttpSecurityConfig {
  harden: boolean;
  requireAuth: boolean;
  authToken?: string;
  restrictOrigins: boolean;
  allowedOrigins: string[];
  enableDnsRebindingProtection: boolean;
  allowedHosts: string[];
  exposeFullConfig: boolean;
  allowPrivateUrls: boolean;
}

function isEnabled(value: string | undefined): boolean {
  return value === 'true';
}

function parseCsv(value: string | undefined): string[] {
  return (value || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

export function getHttpSecurityConfig(): HttpSecurityConfig {
  const harden = isEnabled(process.env.MCP_HTTP_HARDEN);
  const authToken = process.env.MCP_HTTP_AUTH_TOKEN;
  const allowedOrigins = parseCsv(process.env.MCP_HTTP_ALLOWED_ORIGINS);
  const allowedHosts = parseCsv(process.env.MCP_HTTP_ALLOWED_HOSTS);

  return {
    harden,
    requireAuth: harden && !!authToken,
    authToken,
    restrictOrigins: harden && allowedOrigins.length > 0,
    allowedOrigins,
    enableDnsRebindingProtection: harden,
    allowedHosts: allowedHosts.length > 0 ? allowedHosts : ['127.0.0.1', 'localhost'],
    exposeFullConfig: isEnabled(process.env.MCP_HTTP_EXPOSE_FULL_CONFIG),
    allowPrivateUrls: isEnabled(process.env.MCP_HTTP_ALLOW_PRIVATE_URLS),
  };
}

export function isRequestAuthorized(headerValue: string | undefined, config: HttpSecurityConfig): boolean {
  if (!config.requireAuth) return true;
  return headerValue === `Bearer ${config.authToken}` || headerValue === config.authToken;
}

export function isOriginAllowed(origin: string | undefined, config: HttpSecurityConfig): boolean {
  if (!config.restrictOrigins) return true;
  if (!origin) return false;
  return config.allowedOrigins.includes(origin);
}
```

- [ ] **Step 4: Wire the helper into `src/http-server.ts` without changing default behavior**

Update `src/http-server.ts` so it reads `getHttpSecurityConfig()` once, uses dynamic CORS behavior, enables rebinding protection only in hardened mode, and rejects unauthorized requests before session handling:

```ts
import {
  getHttpSecurityConfig,
  isOriginAllowed,
  isRequestAuthorized,
} from './http-security.js';

const security = getHttpSecurityConfig();

app.use(cors({
  origin: (origin, callback) => {
    if (isOriginAllowed(origin || undefined, security)) {
      callback(null, true);
      return;
    }
    callback(new Error('Origin not allowed by HTTP security policy'));
  },
  exposedHeaders: ['Mcp-Session-Id'],
  allowedHeaders: ['Content-Type', 'mcp-session-id', 'authorization'],
}));

function rejectUnauthorized(res: express.Response) {
  res.status(401).json({
    jsonrpc: '2.0',
    error: {
      code: -32001,
      message: 'Unauthorized: missing or invalid HTTP auth token',
    },
    id: null,
  });
}

app.use('/mcp', (req, res, next) => {
  if (!isRequestAuthorized(req.headers.authorization as string | undefined, security)) {
    rejectUnauthorized(res);
    return;
  }
  next();
});

transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: () => randomUUID(),
  onsessioninitialized: (sessionId) => {
    transports[sessionId] = transport;
  },
  enableDnsRebindingProtection: security.enableDnsRebindingProtection,
  allowedHosts: security.allowedHosts,
});
```

Implementation notes:
- compatibility mode should still allow all current requests
- in hardened mode, missing token should fail with `401`
- if hardened mode is enabled but `MCP_HTTP_AUTH_TOKEN` is missing, keep startup behavior explicit by logging or throwing a configuration error during implementation

- [ ] **Step 5: Extend the integration tests for compatibility mode and hardened mode**

Add these cases to `__tests__/integration/http-server.test.ts`:

```ts
import { EnvManager } from '../helpers/env-utils.js';

const envManager = new EnvManager();

await testFunction('compatibility mode still allows health and init flow', async () => {
  envManager.delete('MCP_HTTP_HARDEN');
  envManager.delete('MCP_HTTP_AUTH_TOKEN');

  const app = await createHttpServer(createTestMcpServer());
  const res = await request(app)
    .post('/mcp')
    .set('Content-Type', 'application/json')
    .set('Accept', 'application/json, text/event-stream')
    .send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0.0' }
      }
    });

  assert.equal(res.status, 200);
  envManager.restore();
}, results);

await testFunction('hardened mode rejects initialize without auth token', async () => {
  envManager.set('MCP_HTTP_HARDEN', 'true');
  envManager.set('MCP_HTTP_AUTH_TOKEN', 'secret-token');
  envManager.set('MCP_HTTP_ALLOWED_ORIGINS', 'https://app.example.com');

  const app = await createHttpServer(createTestMcpServer());
  const res = await request(app)
    .post('/mcp')
    .set('Origin', 'https://app.example.com')
    .set('Content-Type', 'application/json')
    .set('Accept', 'application/json, text/event-stream')
    .send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0.0' }
      }
    });

  assert.equal(res.status, 401);
  envManager.restore();
}, results);
```

- [ ] **Step 6: Run the HTTP-focused tests**

Run:

```bash
tsx __tests__/unit/http-security.test.ts
tsx __tests__/integration/http-server.test.ts
```

Expected:

```text
All tests passed
```

- [ ] **Step 7: Commit the HTTP hardening layer**

Run:

```bash
git add src/http-security.ts src/http-server.ts __tests__/unit/http-security.test.ts __tests__/integration/http-server.test.ts
git commit -m "feat: add opt-in HTTP hardening mode"
```

### Task 3: Add Hardened-Mode SSRF Controls And Config Redaction

**Files:**
- Modify: `src/url-reader.ts`
- Modify: `src/resources.ts`
- Modify: `src/error-handler.ts`
- Modify: `__tests__/unit/url-reader.test.ts`
- Modify: `__tests__/unit/resources.test.ts`

- [ ] **Step 1: Add failing URL-reader tests for hardened-mode blocking**

Add these cases to `__tests__/unit/url-reader.test.ts`:

```ts
await testFunction('hardened mode blocks localhost URL reads', async () => {
  const mockServer = createMockServer();
  envManager.set('MCP_HTTP_HARDEN', 'true');
  envManager.delete('MCP_HTTP_ALLOW_PRIVATE_URLS');

  try {
    await fetchAndConvertToMarkdown(mockServer as any, 'http://127.0.0.1:8080/private');
    assert.fail('Expected localhost URL to be blocked');
  } catch (error: any) {
    assert.ok(error.message.includes('blocked by security policy'));
  }

  envManager.restore();
}, results);

await testFunction('override allows localhost URL reads in hardened mode', async () => {
  const mockServer = createMockServer();
  urlCache.clear();
  envManager.set('MCP_HTTP_HARDEN', 'true');
  envManager.set('MCP_HTTP_ALLOW_PRIVATE_URLS', 'true');

  fetchMocker.mock(createMockFetch({ body: '<html><body><h1>Internal</h1></body></html>' }));
  const result = await fetchAndConvertToMarkdown(mockServer as any, 'http://127.0.0.1:8080/private');
  assert.ok(result.includes('Internal'));

  fetchMocker.restore();
  envManager.restore();
}, results);
```

- [ ] **Step 2: Add failing resource tests for hardened-mode redaction**

Add these cases to `__tests__/unit/resources.test.ts`:

```ts
await testFunction('config resource redacts searxngUrl in hardened mode', () => {
  envManager.set('MCP_HTTP_HARDEN', 'true');
  envManager.set('SEARXNG_URL', 'https://search.internal.example');
  envManager.delete('MCP_HTTP_EXPOSE_FULL_CONFIG');

  const config = JSON.parse(createConfigResource());
  assert.equal(config.environment.searxngUrlConfigured, true);
  assert.equal(config.environment.searxngUrl, undefined);

  envManager.restore();
}, results);

await testFunction('debug override exposes full config in hardened mode', () => {
  envManager.set('MCP_HTTP_HARDEN', 'true');
  envManager.set('MCP_HTTP_EXPOSE_FULL_CONFIG', 'true');
  envManager.set('SEARXNG_URL', 'https://search.internal.example');

  const config = JSON.parse(createConfigResource());
  assert.equal(config.environment.searxngUrl, 'https://search.internal.example');

  envManager.restore();
}, results);
```

- [ ] **Step 3: Run the updated tests and confirm they fail before implementation**

Run:

```bash
tsx __tests__/unit/url-reader.test.ts
tsx __tests__/unit/resources.test.ts
```

Expected:
- URL reader tests fail because localhost is not blocked yet
- resource tests fail because redaction fields do not exist yet

- [ ] **Step 4: Add URL policy helpers and block internal targets in hardened mode**

Update `src/url-reader.ts` to apply a policy check before fetch:

```ts
import { getHttpSecurityConfig } from './http-security.js';
import { createURLSecurityPolicyError } from './error-handler.js';
import { isIP } from 'node:net';

function isPrivateHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return lower === 'localhost' || lower.endsWith('.localhost');
}

function isPrivateIpv4(hostname: string): boolean {
  if (isIP(hostname) !== 4) return false;
  return (
    hostname.startsWith('10.') ||
    hostname.startsWith('127.') ||
    hostname.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname) ||
    hostname.startsWith('169.254.')
  );
}

function assertUrlAllowed(url: URL): void {
  const security = getHttpSecurityConfig();
  if (!security.harden || security.allowPrivateUrls) return;

  if (isPrivateHostname(url.hostname) || isPrivateIpv4(url.hostname)) {
    throw createURLSecurityPolicyError(url.toString());
  }
}

// inside fetchAndConvertToMarkdown, after parsing:
assertUrlAllowed(parsedUrl);
```

- [ ] **Step 5: Add a specific error factory for blocked URL reads**

Extend `src/error-handler.ts` with:

```ts
export function createURLSecurityPolicyError(url: string): MCPSearXNGError {
  return new MCPSearXNGError(
    `🔒 URL blocked by security policy: ${url}. ` +
    'Enable MCP_HTTP_ALLOW_PRIVATE_URLS=true only if internal URL reads are intentional.'
  );
}
```

- [ ] **Step 6: Redact config resource details in hardened mode**

Update `src/resources.ts` to use the HTTP security config:

```ts
import { getHttpSecurityConfig } from './http-security.js';

export function createConfigResource() {
  const security = getHttpSecurityConfig();
  const showFullConfig = !security.harden || security.exposeFullConfig;

  const environment = {
    hasAuth: !!(process.env.AUTH_USERNAME && process.env.AUTH_PASSWORD),
    hasProxy: !!(process.env.HTTP_PROXY || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.https_proxy),
    hasNoProxy: !!(process.env.NO_PROXY || process.env.no_proxy),
    nodeVersion: process.version,
    currentLogLevel: getCurrentLogLevel(),
    ...(showFullConfig
      ? { searxngUrl: process.env.SEARXNG_URL || '(not configured)' }
      : { searxngUrlConfigured: !!process.env.SEARXNG_URL }),
  };

  return JSON.stringify({
    serverInfo: {
      name: 'ihor-sokoliuk/mcp-searxng',
      version: packageVersion,
      description: 'MCP server for SearXNG integration',
    },
    environment,
    capabilities: {
      tools: ['searxng_web_search', 'web_url_read'],
      logging: true,
      resources: true,
      transports: process.env.MCP_HTTP_PORT ? ['stdio', 'http'] : ['stdio'],
    },
  }, null, 2);
}
```

- [ ] **Step 7: Run the affected unit tests**

Run:

```bash
tsx __tests__/unit/url-reader.test.ts
tsx __tests__/unit/resources.test.ts
```

Expected:

```text
All tests passed
```

- [ ] **Step 8: Commit the policy and redaction work**

Run:

```bash
git add src/url-reader.ts src/resources.ts src/error-handler.ts __tests__/unit/url-reader.test.ts __tests__/unit/resources.test.ts
git commit -m "feat: add hardened URL policy and config redaction"
```

### Task 4: Document Hardened Mode And Verify The Full Suite

**Files:**
- Modify: `README.md`
- Modify: `src/resources.ts`
- Test: `__tests__/run-all.ts`

- [ ] **Step 1: Update README configuration docs**

Add a “Hardened HTTP mode” subsection near the HTTP transport section in `README.md`:

```md
### Hardened HTTP Mode (Optional)

Default HTTP behavior remains unchanged for backward compatibility.

If you expose the HTTP transport on a network, enable hardened mode:

```bash
MCP_HTTP_PORT=3000 \
MCP_HTTP_HARDEN=true \
MCP_HTTP_AUTH_TOKEN=replace-me \
MCP_HTTP_ALLOWED_ORIGINS=https://app.example.com \
SEARXNG_URL=http://localhost:8080 \
mcp-searxng
```

Available hardening variables:

- `MCP_HTTP_HARDEN`: enables hardened HTTP behavior
- `MCP_HTTP_AUTH_TOKEN`: required auth token for HTTP requests in hardened mode
- `MCP_HTTP_ALLOWED_ORIGINS`: comma-separated CORS allowlist in hardened mode
- `MCP_HTTP_ALLOWED_HOSTS`: optional DNS rebinding allowlist override
- `MCP_HTTP_ALLOW_PRIVATE_URLS`: allows internal URL reads in hardened mode
- `MCP_HTTP_EXPOSE_FULL_CONFIG`: exposes full config resource details in hardened mode for debugging
```

- [ ] **Step 2: Update the help resource text**

Extend the help text in `src/resources.ts` so the generated usage guide documents the hardened mode variables and makes it clear that secure mode is opt-in:

```ts
### HTTP (Optional)
RESTful HTTP transport for web applications. Set `MCP_HTTP_PORT` to enable.

### Hardened HTTP Mode (Optional)
Default behavior remains compatible for existing deployments.
For network-exposed HTTP transport, enable:
- `MCP_HTTP_HARDEN`
- `MCP_HTTP_AUTH_TOKEN`
- `MCP_HTTP_ALLOWED_ORIGINS`
```

- [ ] **Step 3: Run the full test suite**

Run:

```bash
npm test
```

Expected:

```text
All tests passed
```

- [ ] **Step 4: Re-run lint**

Run:

```bash
npm run lint
```

Expected:

```text
0 problems
```

- [ ] **Step 5: Re-run security verification**

Run:

```bash
npm audit --json
npm audit signatures
```

Expected:
- vulnerability total remains `0`
- signature verification succeeds

- [ ] **Step 6: Commit the docs and verification-ready state**

Run:

```bash
git add README.md src/resources.ts
git commit -m "docs: add hardened HTTP mode guidance"
```
