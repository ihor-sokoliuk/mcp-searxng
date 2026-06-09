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

import { spawnSync } from 'node:child_process';
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
