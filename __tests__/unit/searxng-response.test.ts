#!/usr/bin/env tsx

import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_SEARXNG_RESPONSE_MAX_BYTES,
  HARD_MAX_SEARXNG_RESPONSE_BYTES,
  PREVIEW_MAX_SEARXNG_RESPONSE_BYTES,
  cancelAuxiliaryResponseBody,
  readSearxngResponseBody,
  resetSearxngResponseConfigWarningsForTesting,
  resolveSearxngResponseMaxBytes,
} from "../../src/searxng-response.js";
import { createTestResults, exitWithResults, printTestSummary, testFunction } from "../helpers/test-utils.js";

const results = createTestResults();
const encoder = new TextEncoder();

function responseWithChunks(chunks: Uint8Array[], options: { cancelRejects?: boolean; readRejects?: boolean } = {}) {
  let cancelCalls = 0;
  let releaseCalls = 0;
  let index = 0;
  const reader = {
    async read(): Promise<ReadableStreamReadResult<Uint8Array>> {
      if (options.readRejects) {
        throw new Error("read failed");
      }
      const value = chunks[index++];
      return value === undefined ? { done: true, value: undefined } : { done: false, value };
    },
    async cancel(): Promise<void> {
      cancelCalls++;
      if (options.cancelRejects) {
        throw new Error("cancel failed");
      }
    },
    releaseLock(): void {
      releaseCalls++;
    },
  };
  return {
    response: {
      body: {
        getReader: () => reader,
        cancel: () => reader.cancel(),
      },
    } as Response,
    getCancelCalls: () => cancelCalls,
    getReleaseCalls: () => releaseCalls,
  };
}

function createLogger() {
  const messages: string[] = [];
  return {
    server: {
      sendLoggingMessage: async ({ data }: { data: Record<string, unknown> }) => {
        messages.push(String(data.message));
      },
    },
    messages,
  };
}

async function runTests() {
  console.log("🧪 Testing: searxng-response.ts\n");

  await testFunction("exports fixed byte limits", () => {
    assert.equal(DEFAULT_SEARXNG_RESPONSE_MAX_BYTES, 5 * 1024 * 1024);
    assert.equal(HARD_MAX_SEARXNG_RESPONSE_BYTES, 16 * 1024 * 1024);
    assert.equal(PREVIEW_MAX_SEARXNG_RESPONSE_BYTES, 64 * 1024);
  }, results);

  await testFunction("resolves only accepted response-size configuration and warns once without raw values", async () => {
    const previous = process.env.SEARXNG_MAX_RESPONSE_BYTES;
    const logger = createLogger();
    resetSearxngResponseConfigWarningsForTesting();
    try {
      delete process.env.SEARXNG_MAX_RESPONSE_BYTES;
      assert.equal(resolveSearxngResponseMaxBytes(logger.server as any), DEFAULT_SEARXNG_RESPONSE_MAX_BYTES);
      process.env.SEARXNG_MAX_RESPONSE_BYTES = "1";
      assert.equal(resolveSearxngResponseMaxBytes(logger.server as any), 1);
      process.env.SEARXNG_MAX_RESPONSE_BYTES = " 16777216 ";
      assert.equal(resolveSearxngResponseMaxBytes(logger.server as any), HARD_MAX_SEARXNG_RESPONSE_BYTES);
      process.env.SEARXNG_MAX_RESPONSE_BYTES = "  ";
      assert.equal(resolveSearxngResponseMaxBytes(logger.server as any), DEFAULT_SEARXNG_RESPONSE_MAX_BYTES);
      process.env.SEARXNG_MAX_RESPONSE_BYTES = "0";
      assert.equal(resolveSearxngResponseMaxBytes(logger.server as any), DEFAULT_SEARXNG_RESPONSE_MAX_BYTES);
      process.env.SEARXNG_MAX_RESPONSE_BYTES = "16777217";
      assert.equal(resolveSearxngResponseMaxBytes(logger.server as any), DEFAULT_SEARXNG_RESPONSE_MAX_BYTES);
      process.env.SEARXNG_MAX_RESPONSE_BYTES = "5.5";
      assert.equal(resolveSearxngResponseMaxBytes(logger.server as any), DEFAULT_SEARXNG_RESPONSE_MAX_BYTES);
      await Promise.resolve();
      assert.equal(logger.messages.length, 1);
      assert.ok(!logger.messages[0].includes("16777217"));
      resetSearxngResponseConfigWarningsForTesting();
      resolveSearxngResponseMaxBytes(logger.server as any);
      await Promise.resolve();
      assert.equal(logger.messages.length, 2);
    } finally {
      if (previous === undefined) delete process.env.SEARXNG_MAX_RESPONSE_BYTES;
      else process.env.SEARXNG_MAX_RESPONSE_BYTES = previous;
      resetSearxngResponseConfigWarningsForTesting();
    }
  }, results);

  await testFunction("complete mode accepts exact bytes, rejects the next byte, and releases its lock", async () => {
    const exact = responseWithChunks([encoder.encode("abc")]);
    assert.deepEqual(await readSearxngResponseBody(exact.response, 3), {
      text: "abc", bytesRead: 3, truncated: false,
    });
    assert.equal(exact.getReleaseCalls(), 1);
    const overflow = responseWithChunks([encoder.encode("abcd")]);
    await assert.rejects(() => readSearxngResponseBody(overflow.response, 3), /SearXNG response exceeds configured byte limit/);
    assert.equal(overflow.getCancelCalls(), 1);
    assert.equal(overflow.getReleaseCalls(), 1);
    const overflowWithCancelFailure = responseWithChunks([encoder.encode("abcd")], { cancelRejects: true });
    await assert.rejects(
      () => readSearxngResponseBody(overflowWithCancelFailure.response, 3),
      /SearXNG response exceeds configured byte limit/,
    );
    assert.equal(overflowWithCancelFailure.getReleaseCalls(), 1);
  }, results);

  await testFunction("complete mode measures raw UTF-8 bytes before decoding", async () => {
    const response = responseWithChunks([new Uint8Array([0xe2]), new Uint8Array([0x82, 0xac])]);
    assert.deepEqual(await readSearxngResponseBody(response.response, 3), {
      text: "€", bytesRead: 3, truncated: false,
    });
    const partial = responseWithChunks([new Uint8Array([0xe2]), new Uint8Array([0x82])]);
    assert.equal((await readSearxngResponseBody(partial.response, 2)).text, "�");
  }, results);

  await testFunction("preview mode truncates at its effective limit and preserves cancellation result", async () => {
    const truncated = responseWithChunks([encoder.encode("abcd")]);
    assert.deepEqual(await readSearxngResponseBody(truncated.response, 10, { preview: true, previewMaxBytes: 3 }), {
      text: "abc", bytesRead: 4, truncated: true,
    });
    assert.equal(truncated.getCancelCalls(), 1);
    assert.equal(truncated.getReleaseCalls(), 1);
    const cancelRejects = responseWithChunks([encoder.encode("abcd")], { cancelRejects: true });
    const result = await readSearxngResponseBody(cancelRejects.response, 3, { preview: true });
    assert.equal(result.truncated, true);
    assert.equal(cancelRejects.getReleaseCalls(), 1);
  }, results);

  await testFunction("null body is empty while an absent body is rejected without text fallback", async () => {
    assert.deepEqual(await readSearxngResponseBody({ body: null } as Response, 3), {
      text: "", bytesRead: 0, truncated: false,
    });
    const invalidResponse = { text: () => { throw new Error("text must not run"); } } as unknown as Response;
    await assert.rejects(() => readSearxngResponseBody(invalidResponse, 3), /Invalid SearXNG response body/);
  }, results);

  await testFunction("reader failures release the lock and auxiliary cancellation never surfaces cancellation failures", async () => {
    const rejectedRead = responseWithChunks([], { readRejects: true });
    await assert.rejects(() => readSearxngResponseBody(rejectedRead.response, 3), /read failed/);
    assert.equal(rejectedRead.getReleaseCalls(), 1);
    const auxiliary = responseWithChunks([], { cancelRejects: true });
    await cancelAuxiliaryResponseBody(auxiliary.response);
    assert.equal(auxiliary.getCancelCalls(), 1);
  }, results);

  printTestSummary(results, "SearXNG Response Module");
  return results;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  runTests().then(exitWithResults).catch(console.error);
}

export { runTests };
