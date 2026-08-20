import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { BroadcastChannel } from "node:worker_threads";
import { getDocumentProxy } from "unpdf";
import {
  extractPdfText,
  PDF_PARSE_TIMEOUT_MS,
  PDF_WORKER_RESOURCE_LIMITS,
} from "../../src/pdf-reader.js";
import { extractPdfWorkerInput, PDF_DOCUMENT_OPTIONS } from "../../src/pdf-worker.js";
import { createTestResults, printTestSummary, testFunction } from "../helpers/test-utils.js";
import { createEncryptedPdf, createTextPdf } from "../helpers/pdf-fixtures.js";

function createDelayedWorkerUrl(delayMs: number): URL {
  const source =
    `import { parentPort } from "node:worker_threads";` +
    `setTimeout(() => parentPort.postMessage({version:1,kind:"text",text:"delayed",totalPages:1,textBytes:7}), ${delayMs});`;
  return new URL(`data:text/javascript,${encodeURIComponent(source)}`);
}

function createNeverPostingWorkerUrl(): URL {
  const source =
    `import { parentPort } from "node:worker_threads";` +
    `parentPort.on("message", () => {});`;
  return new URL(`data:text/javascript,${encodeURIComponent(source)}`);
}

const HANGING_TEARDOWN_PARENT_TIMEOUT_MS = 3_000;
const HANGING_TEARDOWN_READY_TIMEOUT_MS = 1_500;

function createHangingTeardownWorkerUrl(expectedText: string, channelName: string): URL {
  const unpdfUrl = import.meta.resolve("unpdf");
  const source = `
    import { BroadcastChannel, parentPort, workerData } from "node:worker_threads";
    import { getDocumentProxy } from ${JSON.stringify(unpdfUrl)};

    const readiness = new BroadcastChannel(${JSON.stringify(channelName)});

    try {
      const pdf = await getDocumentProxy(new Uint8Array(workerData.pdfBytes));
      const page = await pdf.getPage(1);
      const content = await page.getTextContent();
      const text = content.items.map((item) => item.str).join("");
      if (text !== ${JSON.stringify(expectedText)}) {
        throw new Error("unexpected worker extraction result");
      }
      const simulatedTeardown = new Promise(() => {});
      readiness.postMessage({ type: "ready" });
      readiness.close();
      setInterval(() => {}, 1000);
      await simulatedTeardown;
    } catch {
      readiness.postMessage({ type: "failure" });
      readiness.close();
      parentPort.postMessage({ version: 1, kind: "parse_error" });
    }
  `;
  return new URL(`data:text/javascript,${encodeURIComponent(source)}`);
}

function waitForWorkerReadiness(channel: BroadcastChannel): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      channel.onmessage = null;
      reject(new Error("worker did not reach simulated teardown before the readiness deadline"));
    }, HANGING_TEARDOWN_READY_TIMEOUT_MS);
    channel.onmessage = (event: MessageEvent<{ type?: unknown }>) => {
      clearTimeout(timeout);
      channel.onmessage = null;
      if (event.data?.type === "ready") {
        resolve();
      } else {
        reject(new Error("worker failed before simulated teardown readiness"));
      }
    };
  });
}

type TestPdfFixture = {
  pdf: {
    numPages: number;
    getPage: () => Promise<{
      getTextContent: () => Promise<{ items: Array<{ str: string }> }>;
      cleanup: () => void;
    }>;
    loadingTask: { destroy: () => Promise<void> };
  };
  destroyCalls: () => number;
};

function createTestPdfFixture({
  text = "",
  numPages = 1,
  pageError,
  destroyError,
}: {
  text?: string;
  numPages?: number;
  pageError?: unknown;
  destroyError?: unknown;
} = {}): TestPdfFixture {
  let destroyCount = 0;
  return {
    pdf: {
      numPages,
      async getPage() {
        if (pageError !== undefined) {
          throw pageError;
        }
        return {
          async getTextContent() {
            return { items: text === "" ? [] : [{ str: text }] };
          },
          cleanup() {},
        };
      },
      loadingTask: {
        async destroy() {
          destroyCount++;
          if (destroyError !== undefined) {
            throw destroyError;
          }
        },
      },
    },
    destroyCalls: () => destroyCount,
  };
}

export async function runTests() {
  const results = createTestResults();

  await testFunction("keeps the parser hardening and resource envelope explicit", () => {
    assert.equal(PDF_PARSE_TIMEOUT_MS, 30_000);
    assert.deepEqual(PDF_WORKER_RESOURCE_LIMITS, {
      maxOldGenerationSizeMb: 192,
      stackSizeMb: 4,
    });
    assert.deepEqual(PDF_DOCUMENT_OPTIONS, {
      isEvalSupported: false,
      enableXfa: false,
      useSystemFonts: false,
      disableFontFace: true,
      disableAutoFetch: true,
      disableStream: true,
      useWorkerFetch: false,
      useWasm: false,
      cMapUrl: undefined,
      standardFontDataUrl: undefined,
      wasmUrl: undefined,
      iccUrl: undefined,
      verbosity: 0,
    });
  }, results);

  await testFunction("tears down the loaded document once after every settled extraction result", async () => {
    const cases = [
      { name: "text", fixture: createTestPdfFixture({ text: "hello" }), maxTextBytes: 1024, expected: { version: 1, kind: "text", text: "hello", totalPages: 1, textBytes: 5 } },
      { name: "text with teardown failure", fixture: createTestPdfFixture({ text: "hello", destroyError: new Error("teardown") }), maxTextBytes: 1024, expected: { version: 1, kind: "text", text: "hello", totalPages: 1, textBytes: 5 } },
      { name: "no text", fixture: createTestPdfFixture(), maxTextBytes: 1024, expected: { version: 1, kind: "no_text", totalPages: 1 } },
      { name: "text too large", fixture: createTestPdfFixture({ text: "too large" }), maxTextBytes: 1, expected: { version: 1, kind: "text_too_large", bytes: 9 } },
      { name: "too many pages", fixture: createTestPdfFixture({ numPages: 501 }), maxTextBytes: 1024, expected: { version: 1, kind: "too_many_pages", totalPages: 501 } },
      { name: "parse error", fixture: createTestPdfFixture({ pageError: new Error("parse") }), maxTextBytes: 1024, expected: { version: 1, kind: "parse_error" } },
      { name: "password error", fixture: createTestPdfFixture({ pageError: { name: "PasswordException" } }), maxTextBytes: 1024, expected: { version: 1, kind: "password_protected" } },
      { name: "external fetch", fixture: createTestPdfFixture({ pageError: { name: "ExternalFetchAttemptError" } }), maxTextBytes: 1024, expected: { version: 1, kind: "external_fetch_attempt" } },
    ];

    for (const testCase of cases) {
      const result = await extractPdfWorkerInput({
        version: 1,
        pdfBytes: new ArrayBuffer(1),
        maxTextBytes: testCase.maxTextBytes,
      }, async () => testCase.fixture.pdf as never);
      assert.deepEqual(result, testCase.expected, testCase.name);
      assert.equal(testCase.fixture.destroyCalls(), 1, `${testCase.name} teardown count`);
    }
  }, results);

  await testFunction("awaits one real unpdf loading-task teardown through worker extraction", async () => {
    const documentBytes = createTextPdf(["real loading task"]);
    const inputBytes = documentBytes.slice();
    const pdf = await getDocumentProxy(documentBytes, PDF_DOCUMENT_OPTIONS);
    const originalDestroy = pdf.loadingTask.destroy.bind(pdf.loadingTask);
    let destroyCalls = 0;
    pdf.loadingTask.destroy = async () => {
      destroyCalls++;
      await originalDestroy();
    };

    try {
      const result = await extractPdfWorkerInput({
        version: 1,
        pdfBytes: inputBytes.buffer,
        maxTextBytes: 1024,
      }, async () => pdf);
      assert.deepEqual(result, {
        version: 1,
        kind: "text",
        text: "real loading task",
        totalPages: 1,
        textBytes: 17,
      });
      assert.equal(destroyCalls, 1);
    } finally {
      if (destroyCalls === 0) {
        await originalDestroy();
      }
    }
  }, results);

  await testFunction("extracts text from a real in-memory PDF", async () => {
    const result = await extractPdfText(createTextPdf(["Hello PDF", "Second page"]), 1024);
    assert.deepEqual(result, {
      version: 1,
      kind: "text",
      text: "Hello PDF\nSecond page",
      totalPages: 2,
      textBytes: 21,
    });
  }, results);

  await testFunction("removes unsafe control characters from extracted text", async () => {
    const result = await extractPdfText(createTextPdf(["safe\u0000text\u0007"]), 1024);
    assert.equal(result.kind, "text");
    assert.ok(result.kind !== "text" || result.text === "safe text");
    assert.ok(
      result.kind !== "text"
      || [...result.text].every((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint === 0x09
          || codePoint === 0x0a
          || codePoint === 0x0d
          || (codePoint >= 0x20 && codePoint !== 0x7f);
      }),
    );
  }, results);

  await testFunction("reports PDFs with no extractable text", async () => {
    const result = await extractPdfText(createTextPdf([""]), 1024);
    assert.deepEqual(result, { version: 1, kind: "no_text", totalPages: 1 });
  }, results);

  await testFunction("rejects malformed PDF bytes without exposing parser errors", async () => {
    const result = await extractPdfText(new TextEncoder().encode("%PDF-not-valid"), 1024);
    assert.deepEqual(result, { version: 1, kind: "parse_error" });
  }, results);

  await testFunction("classifies an actual encrypted PDF without exposing parser errors", async () => {
    const result = await extractPdfText(createEncryptedPdf(), 1024);
    assert.deepEqual(result, { version: 1, kind: "password_protected" });
  }, results);

  await testFunction("caps extracted text by UTF-8 byte length", async () => {
    const result = await extractPdfText(createTextPdf(["This text is too long"]), 8);
    assert.equal(result.kind, "text_too_large");
    assert.ok(result.kind !== "text_too_large" || result.bytes > 8);
  }, results);

  await testFunction("rejects documents over the page limit", async () => {
    const result = await extractPdfText(createTextPdf(Array.from({ length: 501 }, () => "")), 1024);
    assert.deepEqual(result, { version: 1, kind: "too_many_pages", totalPages: 501 });
  }, results);

  await testFunction("terminates a worker when the parser budget expires", async () => {
    const result = await extractPdfText(createTextPdf(["ignored"]), 1024, {
      timeoutMs: 20,
      workerUrl: createDelayedWorkerUrl(1000),
    });
    assert.deepEqual(result, { version: 1, kind: "timeout" });
  }, results);

  await testFunction("times out a never-posting worker and releases its concurrency slot", async () => {
    const workerUrl = createNeverPostingWorkerUrl();
    const first = extractPdfText(createTextPdf(["first ignored"]), 1024, {
      timeoutMs: 20,
      workerUrl,
    });
    const second = extractPdfText(createTextPdf(["second ignored"]), 1024, {
      timeoutMs: 20,
      workerUrl,
    });
    assert.deepEqual(await first, { version: 1, kind: "timeout" });
    assert.deepEqual(await second, { version: 1, kind: "timeout" });

    const next = await extractPdfText(createTextPdf(["after timeout"]), 1024);
    assert.equal(next.kind, "text");
  }, results);

  await testFunction("parent timeout reclaims a worker that hangs after real PDF extraction", async () => {
    const readiness = new BroadcastChannel(`pdf-hanging-teardown-${randomUUID()}`);
    const pending = extractPdfText(createTextPdf(["worker teardown"]), 1024, {
      timeoutMs: HANGING_TEARDOWN_PARENT_TIMEOUT_MS,
      workerUrl: createHangingTeardownWorkerUrl("worker teardown", readiness.name),
    });

    try {
      await waitForWorkerReadiness(readiness);
      assert.deepEqual(await pending, { version: 1, kind: "timeout" });
    } catch (error) {
      await pending;
      throw error;
    } finally {
      readiness.close();
    }

    const next = await extractPdfText(createTextPdf(["after hanging teardown"]), 1024);
    assert.equal(next.kind, "text");
  }, results);

  await testFunction("cancellation terminates the worker and promptly releases its slot", async () => {
    const controller = new AbortController();
    const workerUrl = createDelayedWorkerUrl(10_000);
    const pending = extractPdfText(createTextPdf(["cancel"]), 1024, {
      workerUrl,
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    const started = Date.now();
    controller.abort(new DOMException("cancelled", "AbortError"));
    await assert.rejects(pending, /cancelled/u);
    assert.ok(Date.now() - started < 1000);

    const next = await extractPdfText(createTextPdf(["after"]), 1024);
    assert.equal(next.kind, "text");
  }, results);

  await testFunction("accepts the worker external-fetch sentinel without leaking details", async () => {
    const source =
      `import { parentPort } from "node:worker_threads";` +
      `parentPort.postMessage({version:1,kind:"external_fetch_attempt"});`;
    const result = await extractPdfText(createTextPdf(["ignored"]), 1024, {
      workerUrl: new URL(`data:text/javascript,${encodeURIComponent(source)}`),
    });
    assert.deepEqual(result, { version: 1, kind: "external_fetch_attempt" });
  }, results);

  await testFunction("does not consume a worker slot when copying input bytes fails", async () => {
    const bytes = createTextPdf(["copy failure"]);
    Object.defineProperty(bytes, "slice", {
      value: () => {
        throw new Error("simulated copy failure");
      },
    });

    await assert.rejects(extractPdfText(bytes, 1024), /simulated copy failure/);

    const workerUrl = createDelayedWorkerUrl(100);
    const first = extractPdfText(createTextPdf(["one"]), 1024, { workerUrl });
    const second = extractPdfText(createTextPdf(["two"]), 1024, { workerUrl });
    const third = await extractPdfText(createTextPdf(["three"]), 1024, { workerUrl });

    assert.deepEqual(third, { version: 1, kind: "busy" });
    assert.equal((await first).kind, "text");
    assert.equal((await second).kind, "text");
  }, results);

  await testFunction("admits at most two concurrent PDF workers without queueing", async () => {
    const workerUrl = createDelayedWorkerUrl(100);
    const first = extractPdfText(createTextPdf(["one"]), 1024, { workerUrl });
    const second = extractPdfText(createTextPdf(["two"]), 1024, { workerUrl });
    const third = await extractPdfText(createTextPdf(["three"]), 1024, { workerUrl });

    assert.deepEqual(third, { version: 1, kind: "busy" });
    assert.equal((await first).kind, "text");
    assert.equal((await second).kind, "text");
  }, results);

  printTestSummary(results, "PDF Reader");
  return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void runTests();
}
