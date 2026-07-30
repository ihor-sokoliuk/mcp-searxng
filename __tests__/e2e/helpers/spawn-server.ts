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

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
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
