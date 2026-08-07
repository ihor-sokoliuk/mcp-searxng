/**
 * E2E helper: spawn the built MCP binary and parse JSON-RPC responses.
 *
 * Usage:
 *   const skip = checkSkipConditions();
 *   if (skip) { console.log(skip); process.exit(0); }
 *
 *   const responses = spawnWithMessages([
 *     { jsonrpc: '2.0', id: 1, method: 'initialize', params: { ... } },
 *     { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { ... } },
 *   ]);
 *   const toolResult = responses[2]; // keyed by id
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';

const DIST_CLI = path.join(process.cwd(), 'dist', 'cli.js');

export const LIVE_URL = process.env.SEARXNG_LIVE_URL;

/**
 * Returns a skip message if e2e preconditions aren't met, or null if ready to run.
 * Pass `requireLiveUrl = false` for tests that use a local hanging server instead.
 */
export function checkSkipConditions(requireLiveUrl = true): string | null {
  if (requireLiveUrl && !LIVE_URL) {
    return '[SKIP] SEARXNG_LIVE_URL not set — skipping live e2e tests';
  }
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  if (!existsSync(DIST_CLI)) {
    return '[SKIP] dist/cli.js not found — run `npm run build` first';
  }
  return null;
}

/** Standard MCP initialize params */
export const INIT_PARAMS = {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'e2e-test', version: '1.0.0' },
};

/**
 * Starts the built CLI in HTTP transport mode for local end-to-end tests.
 */
export interface SpawnedHttpCli {
  url: URL;
  health: unknown;
  close: () => Promise<void>;
}

export interface SpawnHttpCliOptions {
  stateless?: boolean;
  readyTimeoutMs?: number;
  args?: string[];
  /** @internal Narrow test seam for exercising an EADDRINUSE retry. */
  reservePort?: () => Promise<number>;
}

const MAX_HTTP_CLI_START_ATTEMPTS = 2;
const MAX_CAPTURED_OUTPUT_CHARS = 64 * 1024;

const CHILD_SYSTEM_ENV_KEYS = new Set([
  'ComSpec',
  'COMSPEC',
  'Path',
  'PATH',
  'PATHEXT',
  'SystemRoot',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
]);

function createHttpCliEnvironment(port: number, stateless: boolean): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && CHILD_SYSTEM_ENV_KEYS.has(key)) environment[key] = value;
  }
  return {
    ...environment,
    MCP_HTTP_HOST: '127.0.0.1',
    MCP_HTTP_PORT: String(port),
    MCP_HTTP_STATELESS: stateless ? 'true' : 'false',
    SEARXNG_URL: 'http://127.0.0.1:1',
  };
}

function diagnostics(child: ChildProcess, stdout: string, stderr: string): string {
  return `exitCode=${child.exitCode}; signalCode=${child.signalCode}; stdout=${JSON.stringify(stdout)}; stderr=${JSON.stringify(stderr)}`;
}

function appendOutputTail(current: string, chunk: string): string {
  return `${current}${chunk}`.slice(-MAX_CAPTURED_OUTPUT_CHARS);
}

async function reserveLoopbackPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const reservation = createServer();
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', () => {
      const address = reservation.address();
      if (!address || typeof address === 'string') {
        reservation.close(() => reject(new Error('Failed to reserve a loopback port')));
        return;
      }
      reservation.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function waitForHealth(
  child: ChildProcess,
  healthUrl: URL,
  captured: () => { stdout: string; stderr: string },
  getSpawnError: () => Error | undefined,
  timeoutMs = 10000,
): Promise<unknown> {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    const spawnError = getSpawnError();
    if (spawnError) {
      const { stdout, stderr } = captured();
      throw new Error(`HTTP CLI failed to spawn: ${spawnError.message}; ${diagnostics(child, stdout, stderr)}`);
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      const { stdout, stderr } = captured();
      throw new Error(`HTTP CLI exited before health became ready: ${diagnostics(child, stdout, stderr)}`);
    }
    try {
      const response = await fetch(healthUrl, { signal: AbortSignal.timeout(500) });
      if (response.ok) return await response.json();
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const { stdout, stderr } = captured();
  throw new Error(`Timed out waiting for HTTP CLI health after ${timeoutMs}ms: lastError=${lastError}; ${diagnostics(child, stdout, stderr)}`);
}

/** Starts the built CLI on an isolated loopback port and waits for /health. */
export async function spawnHttpCli(options: SpawnHttpCliOptions = {}): Promise<SpawnedHttpCli> {
  const { stateless = false, readyTimeoutMs = 10000, args = [DIST_CLI], reservePort = reserveLoopbackPort } = options;
  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= MAX_HTTP_CLI_START_ATTEMPTS; attempt++) {
    let port: number;
    try {
      port = await reservePort();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (!lastError.message.includes('EADDRINUSE') || attempt === MAX_HTTP_CLI_START_ATTEMPTS) break;
      continue;
    }
    const url = new URL(`http://127.0.0.1:${port}/mcp`);
    let stdout = '';
    let stderr = '';
    let spawnError: Error | undefined;
    const child = spawn(process.execPath, args, {
      env: createHttpCliEnvironment(port, stateless),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout = appendOutputTail(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = appendOutputTail(stderr, chunk); });
    child.once('error', (error) => { spawnError = error; });

    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
    const close = async (): Promise<void> => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      const completed = await Promise.race([
        closed.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5000)),
      ]);
      if (!completed && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        const forced = await Promise.race([
          closed.then(() => true),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5000)),
        ]);
        if (!forced) throw new Error(`HTTP CLI did not exit after forced cleanup: ${diagnostics(child, stdout, stderr)}`);
      }
    };

    try {
      const health = await waitForHealth(
        child,
        new URL('/health', url),
        () => ({ stdout, stderr }),
        () => spawnError,
        readyTimeoutMs,
      );
      return { url, health, close };
    } catch (error) {
      await close();
      const message = error instanceof Error ? error.message : String(error);
      lastError = new Error(`${message}; cleanup=${diagnostics(child, stdout, stderr)}`);
      if (!lastError.message.includes('EADDRINUSE') || attempt === MAX_HTTP_CLI_START_ATTEMPTS) break;
    }
  }
  if (!lastError?.message.includes('EADDRINUSE')) throw lastError;
  throw new Error(`HTTP CLI startup exhausted ${MAX_HTTP_CLI_START_ATTEMPTS} attempts after confirmed EADDRINUSE: ${lastError.message}`);
}

/**
 * Spawn the built MCP binary, pipe `messages` as newline-delimited JSON to stdin,
 * and return parsed responses keyed by id.
 *
 * @param messages - Array of JSON-RPC message objects to send
 * @param searxngUrl - SEARXNG_URL to pass to the server (default: LIVE_URL)
 * @param timeoutMs - spawnSync timeout in milliseconds (default: 15000)
 */
export function spawnWithMessages(
  messages: object[],
  searxngUrl: string = LIVE_URL ?? '',
  timeoutMs = 15000
): Record<number, any> {
  const input = messages.map((m) => JSON.stringify(m)).join('\n') + '\n';

  const result = spawnSync('node', [DIST_CLI], {
    input,
    env: { ...process.env, SEARXNG_URL: searxngUrl },
    encoding: 'utf8',
    timeout: timeoutMs,
  });

  if (result.error) {
    throw new Error(`spawnSync failed: ${result.error.message}`);
  }

  const responses: Record<number, any> = {};
  for (const line of result.stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const msg = JSON.parse(trimmed);
      if (msg.id !== undefined) {
        responses[msg.id] = msg;
      }
    } catch {
      // notifications and unparseable lines are ignored
    }
  }
  return responses;
}

/**
 * Asynchronous variant used when the parent process hosts local target or
 * solver servers that must continue servicing requests while the MCP child is
 * running.
 */
export async function spawnWithMessagesAsync(
  messages: object[],
  searxngUrl: string = LIVE_URL ?? '',
  timeoutMs = 15000,
  environmentOverrides: NodeJS.ProcessEnv = {},
): Promise<Record<number, any>> {
  const input = messages.map((message) => JSON.stringify(message)).join('\n') + '\n';

  return await new Promise((resolve, reject) => {
    const child = spawn('node', [DIST_CLI], {
      env: {
        ...process.env,
        ...environmentOverrides,
        SEARXNG_URL: searxngUrl,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timeout);
      if (timedOut) {
        reject(new Error(`MCP child timed out after ${timeoutMs}ms`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`MCP child exited with code ${code}: ${stderr.trim()}`));
        return;
      }

      const responses: Record<number, any> = {};
      for (const line of stdout.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        try {
          const message = JSON.parse(trimmed);
          if (message.id !== undefined) {
            responses[message.id] = message;
          }
        } catch {
          // Notifications and unparseable lines are ignored.
        }
      }
      resolve(responses);
    });

    child.stdin.end(input);
  });
}
