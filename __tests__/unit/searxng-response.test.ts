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

interface StreamOptions {
  cancelRejects?: boolean;
  leaveOpen?: boolean;
  readRejects?: boolean;
  pending?: boolean;
}

function responseWithChunks(chunks: Uint8Array[], options: StreamOptions = {}) {
  let cancelCalls = 0;
  let cancelReason: unknown;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (options.readRejects) {
        controller.error(new Error("read failed"));
        return;
      }
      if (!options.pending) {
        for (const chunk of chunks) controller.enqueue(chunk);
        if (!options.leaveOpen) controller.close();
      }
    },
    cancel(reason) {
      cancelCalls++;
      cancelReason = reason;
      if (options.cancelRejects) return Promise.reject(new Error("cancel failed"));
      return undefined;
    },
  });
  const response = new Response(stream);
  return {
    response,
    getCancelCalls: () => cancelCalls,
    getCancelReason: () => cancelReason,
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

async function expectPromptAbort(promise: Promise<unknown>, reason: Error): Promise<void> {
  await assert.rejects(
    Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("abort was not prompt")), 50)),
    ]),
    (error: unknown) => error === reason,
  );
}

async function runTests() {
  console.log("🧪 Testing: searxng-response.ts\n");

  await testFunction("exports fixed byte limits", () => {
    assert.equal(DEFAULT_SEARXNG_RESPONSE_MAX_BYTES, 5 * 1024 * 1024);
    assert.equal(HARD_MAX_SEARXNG_RESPONSE_BYTES, 16 * 1024 * 1024);
    assert.equal(PREVIEW_MAX_SEARXNG_RESPONSE_BYTES, 64 * 1024);
  }, results);

  await testFunction("pins accepted and rejected response-size configuration forms with value-free once-only warnings", async () => {
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
      process.env.SEARXNG_MAX_RESPONSE_BYTES = "+5242880";
      assert.equal(resolveSearxngResponseMaxBytes(logger.server as any), 5242880);
      process.env.SEARXNG_MAX_RESPONSE_BYTES = "0005242880";
      assert.equal(resolveSearxngResponseMaxBytes(logger.server as any), 5242880);
      process.env.SEARXNG_MAX_RESPONSE_BYTES = "  ";
      assert.equal(resolveSearxngResponseMaxBytes(logger.server as any), DEFAULT_SEARXNG_RESPONSE_MAX_BYTES);
      for (const invalid of ["0", "16777217", "5.5", "-0", "1e3", "5MB", "9007199254740992"]) {
        process.env.SEARXNG_MAX_RESPONSE_BYTES = invalid;
        assert.equal(resolveSearxngResponseMaxBytes(logger.server as any), DEFAULT_SEARXNG_RESPONSE_MAX_BYTES);
      }
      await Promise.resolve();
      assert.equal(logger.messages.length, 1);
      assert.ok(!logger.messages[0].includes("9007199254740992"));
      resetSearxngResponseConfigWarningsForTesting();
      process.env.SEARXNG_MAX_RESPONSE_BYTES = "5MB";
      resolveSearxngResponseMaxBytes(logger.server as any);
      await Promise.resolve();
      assert.equal(logger.messages.length, 2);
    } finally {
      if (previous === undefined) delete process.env.SEARXNG_MAX_RESPONSE_BYTES;
      else process.env.SEARXNG_MAX_RESPONSE_BYTES = previous;
      resetSearxngResponseConfigWarningsForTesting();
    }
  }, results);

  await testFunction("complete mode accepts exact bytes, rejects the next byte, cancels, and unlocks actual bodies", async () => {
    const exact = responseWithChunks([encoder.encode("abc")]);
    assert.deepEqual(await readSearxngResponseBody(exact.response, 3), {
      text: "abc", bytesRead: 3, truncated: false,
    });
    assert.equal(exact.response.body!.locked, false);
    const overflow = responseWithChunks([encoder.encode("abcd")], { leaveOpen: true });
    await assert.rejects(() => readSearxngResponseBody(overflow.response, 3), /SearXNG response exceeds configured byte limit/);
    assert.equal(overflow.getCancelCalls(), 1);
    assert.equal(overflow.response.body!.locked, false);
    const overflowWithCancelFailure = responseWithChunks([encoder.encode("abcd")], { cancelRejects: true, leaveOpen: true });
    await assert.rejects(
      () => readSearxngResponseBody(overflowWithCancelFailure.response, 3),
      /SearXNG response exceeds configured byte limit/,
    );
    assert.equal(overflowWithCancelFailure.getCancelCalls(), 1);
    assert.equal(overflowWithCancelFailure.response.body!.locked, false);
  }, results);

  await testFunction("complete mode measures raw UTF-8 bytes before decoding with actual bodies", async () => {
    const response = responseWithChunks([new Uint8Array([0xe2]), new Uint8Array([0x82, 0xac])]);
    assert.deepEqual(await readSearxngResponseBody(response.response, 3), {
      text: "€", bytesRead: 3, truncated: false,
    });
    assert.equal(response.response.body!.locked, false);
    const partial = responseWithChunks([new Uint8Array([0xe2]), new Uint8Array([0x82])]);
    assert.equal((await readSearxngResponseBody(partial.response, 2)).text, "�");
    assert.equal(partial.response.body!.locked, false);
  }, results);

  await testFunction("preview mode truncates at its effective limit, cancels, and unlocks actual bodies", async () => {
    const truncated = responseWithChunks([encoder.encode("abcd")], { leaveOpen: true });
    assert.deepEqual(await readSearxngResponseBody(truncated.response, 10, { preview: true, previewMaxBytes: 3 }), {
      text: "abc", bytesRead: 4, truncated: true,
    });
    assert.equal(truncated.getCancelCalls(), 1);
    assert.equal(truncated.response.body!.locked, false);
    const cancelRejects = responseWithChunks([encoder.encode("abcd")], { cancelRejects: true, leaveOpen: true });
    const result = await readSearxngResponseBody(cancelRejects.response, 3, { preview: true });
    assert.equal(result.truncated, true);
    assert.equal(cancelRejects.getCancelCalls(), 1);
    assert.equal(cancelRejects.response.body!.locked, false);
  }, results);

  await testFunction("null body is empty while an absent body is rejected without text fallback", async () => {
    assert.deepEqual(await readSearxngResponseBody({ body: null } as Response, 3), {
      text: "", bytesRead: 0, truncated: false,
    });
    const invalidResponse = { text: () => { throw new Error("text must not run"); } } as unknown as Response;
    await assert.rejects(() => readSearxngResponseBody(invalidResponse, 3), /Invalid SearXNG response body/);
  }, results);

  await testFunction("reader failures unlock actual bodies and auxiliary cancellation hides cancellation rejection", async () => {
    const rejectedRead = responseWithChunks([], { readRejects: true });
    await assert.rejects(() => readSearxngResponseBody(rejectedRead.response, 3), /read failed/);
    assert.equal(rejectedRead.response.body!.locked, false);
    const auxiliary = responseWithChunks([], { pending: true, cancelRejects: true });
    await cancelAuxiliaryResponseBody(auxiliary.response);
    assert.equal(auxiliary.getCancelCalls(), 1);
    assert.equal(auxiliary.response.body!.locked, false);
  }, results);

  await testFunction("signal abort cancels through the reader, unlocks the actual body, and keeps abort stable when cancel rejects", async () => {
    const controller = new AbortController();
    const reason = new Error("caller aborted");
    const pending = responseWithChunks([], { pending: true });
    const read = readSearxngResponseBody(pending.response, 3, { signal: controller.signal });
    await Promise.resolve();
    controller.abort(reason);
    await expectPromptAbort(read, reason);
    assert.equal(pending.getCancelCalls(), 1);
    assert.equal(pending.getCancelReason(), reason);
    assert.equal(pending.response.body!.locked, false);

    const rejectingController = new AbortController();
    const rejectingReason = new Error("caller aborted with rejecting cancel");
    const rejecting = responseWithChunks([], { pending: true, cancelRejects: true });
    const rejectingRead = readSearxngResponseBody(rejecting.response, 3, { signal: rejectingController.signal });
    await Promise.resolve();
    rejectingController.abort(rejectingReason);
    await expectPromptAbort(rejectingRead, rejectingReason);
    assert.equal(rejecting.getCancelCalls(), 1);
    assert.equal(rejecting.response.body!.locked, false);
  }, results);

  printTestSummary(results, "SearXNG Response Module");
  return results;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  runTests().then(exitWithResults).catch(console.error);
}

export { runTests };
