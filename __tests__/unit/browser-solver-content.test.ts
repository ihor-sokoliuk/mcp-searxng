import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";
import { browserSolverContentResponse, browserSolverEnvelopeLimit } from "../../src/browser-solver-content.js";
import type { BrowserSolverSolution } from "../../src/browser-solver.js";
import { createTestResults, printTestSummary, testFunction } from "../helpers/test-utils.js";
import { EnvManager } from "../helpers/env-utils.js";
import { resetDiagnosticSanitizerForTests } from "../../src/diagnostic-sanitizer.js";

export async function runTests() {
  const results = createTestResults();
  const solution = (extra: Partial<BrowserSolverSolution>): BrowserSolverSolution => ({
    url: "https://example.com/page", status: 200, cookies: [], userAgent: "browser", ...extra,
  });
  await testFunction("solver HTML detects fields without trusting provider versions", async () => {
    for (const extra of [
      { response: "<html><body>content</body></html>" },
      { response: "<main>content</main>", contentType: "text/html; charset=utf-8" },
      { response: "<main>content</main>", headers: { "CONTENT-TYPE": "text/html" } },
      { response: '<html\nlang="en"><body>content</body></html>' },
      { response: '<html><div id="viewerContainer">content</div><iframe id="plugin"></iframe></html>' },
    ]) {
      const response = browserSolverContentResponse("flaresolverr", solution(extra), 1000);
      assert.ok((await response?.text())?.includes("content"));
    }
  }, results);
  await testFunction("solver rejects ambiguous bodies and PDF viewer shells for replay", () => {
    for (const extra of [
      {}, { response: " " }, { response: "untyped text" },
      { response: "<main>text</main>", contentType: "application/json" },
      { response: "<html><embed type='application/pdf'></html>" },
      { response: "<html><object type='application/x-google-chrome-pdf'></object></html>" },
      { response: "<html><pdf-viewer></pdf-viewer></html>" },
      { response: '<html><head></head><body><pre>{"value":42}</pre></body></html>' },
      { response: '<html><body style="margin: 0px"><img src="https://example.com/image.png"></body></html>' },
      { response: '<html><body><div class="json-formatter-container"></div><pre>{}</pre></body></html>' },
      { response: '<html><head><link rel="stylesheet" href="chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/pdf_embedder.css"></head><body></body></html>' },
      { response: "JVBERi0=", contentType: "application/pdf" },
    ]) assert.equal(browserSolverContentResponse("flaresolverr", solution(extra), 1000), null);
  }, results);
  await testFunction("envelope capacity accounts for JSON escaping and shrinks with configured limits", () => {
    assert.equal(browserSolverEnvelopeLimit(1024), 6 * 1024 + 256 * 1024);
    assert.ok(browserSolverEnvelopeLimit(5 * 1024 * 1024) <= 32 * 1024 * 1024);
    assert.equal(browserSolverEnvelopeLimit(Number.MAX_SAFE_INTEGER), browserSolverEnvelopeLimit(16 * 1024 * 1024));
  }, results);
  await testFunction("Byparr contentType selects PDF despite original HTML headers", async () => {
    const body = Buffer.from("%PDF-1.7\nfixture");
    const response = browserSolverContentResponse("byparr", solution({
      contentType: "application/pdf", headers: { "content-type": "text/html" }, response: body.toString("base64"),
    }), 1000);
    assert.equal(response?.headers.get("content-type"), "application/pdf");
    assert.deepEqual(Buffer.from(await response!.arrayBuffer()), body);
  }, results);
  await testFunction("solver content size and integrity failures are terminal", () => {
    for (const response of ["!!!!", "JVBERi0", "JVBERi0===", "YWJjZA==", "JVBERi1=", "J VBERi0="]) {
      assert.throws(() => browserSolverContentResponse("byparr", solution({ response, contentType: "application/pdf" }), 1000), /PDF/);
    }
    assert.throws(() => browserSolverContentResponse("byparr", solution({ response: Buffer.from("%PDF-123456").toString("base64"), contentType: "application/pdf" }), 5), /limit|invalid/);
    assert.throws(() => browserSolverContentResponse("flaresolverr", solution({ response: "<html>ééé</html>" }), 16), /limit/);
    assert.throws(() => browserSolverContentResponse("byparr", solution({ response: "<html>\0</html>" }), 1000), /binary/);
  }, results);
  await testFunction("rendered solver content cannot reflect configured credentials", () => {
    const env = new EnvManager();
    try {
      env.set("AUTH_PASSWORD", "solver-secret-fixture");
      resetDiagnosticSanitizerForTests();
      assert.throws(() => browserSolverContentResponse("byparr", solution({ response: "<html>solver-secret-fixture</html>" }), 1000));
    } finally { env.restore(); resetDiagnosticSanitizerForTests(); }
  }, results);
  printTestSummary(results, "Browser Solver Content");
  return results;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runTests().then(result => process.exit(result.failed ? 1 : 0));
}
