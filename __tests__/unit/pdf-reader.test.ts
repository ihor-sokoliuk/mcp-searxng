import assert from "node:assert/strict";
import {
  extractPdfText,
  PDF_PARSE_TIMEOUT_MS,
  PDF_WORKER_RESOURCE_LIMITS,
} from "../../src/pdf-reader.js";
import { PDF_DOCUMENT_OPTIONS } from "../../src/pdf-worker.js";
import { createTestResults, printTestSummary, testFunction } from "../helpers/test-utils.js";
import { createEncryptedPdf, createTextPdf } from "../helpers/pdf-fixtures.js";

function createDelayedWorkerUrl(delayMs: number): URL {
  const source =
    `import { parentPort } from "node:worker_threads";` +
    `setTimeout(() => parentPort.postMessage({version:1,kind:"text",text:"delayed",totalPages:1,textBytes:7}), ${delayMs});`;
  return new URL(`data:text/javascript,${encodeURIComponent(source)}`);
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
