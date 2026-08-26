#!/usr/bin/env tsx

/**
 * Unit Tests: web-images.ts
 *
 * Tests for image reference extraction from markdown and bounded image
 * inlining (web_url_read images:"inline").
 */

import { strict as assert } from 'node:assert';
import * as http from 'node:http';
import { fileURLToPath } from 'node:url';
import {
  extractImageRefs,
  inlineImages,
  getImageLimits,
  DEFAULT_MAX_IMAGES,
  DEFAULT_MAX_IMAGE_BYTES,
  DEFAULT_MAX_TOTAL_IMAGE_BYTES,
  type ImageLimits,
} from '../../src/web-images.js';
import { testFunction, createTestResults, printTestSummary, type TestResult } from '../helpers/test-utils.js';
import { EnvManager } from '../helpers/env-utils.js';

const PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const limits: ImageLimits = {
  maxImages: DEFAULT_MAX_IMAGES,
  maxImageBytes: DEFAULT_MAX_IMAGE_BYTES,
  maxTotalBytes: DEFAULT_MAX_TOTAL_IMAGE_BYTES,
};

function startImageServer(handlers: Array<{ path: string; status?: number; body?: string; buffer?: Buffer; contentType?: string; hang?: boolean }>): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const handler = handlers.find((h) => req.url === h.path);
      if (!handler) {
        res.writeHead(404).end("not found");
        return;
      }
      if (handler.hang) {
        return; // never respond
      }
      res.writeHead(handler.status ?? 200, { "Content-Type": handler.contentType ?? "application/octet-stream" });
      res.end(handler.buffer ?? handler.body ?? "");
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

async function runTests(): Promise<TestResult> {
  const results = createTestResults();
  const envManager = new EnvManager();

  // ─── extractImageRefs ───────────────────────────────────────────────────────

  await testFunction("extractImageRefs finds image links with alt, heading, and resolved src", () => {
    const markdown = [
      "# Top",
      "",
      "## Benchmarks",
      "text ![chart](bench.png \"Chart\") more",
      "![plain](https://img.example/a.gif)",
    ].join("\n");
    const refs = extractImageRefs(markdown, new URL("https://site.example/page/"), 6);
    assert.equal(refs.length, 2);
    assert.equal(refs[0].alt, "chart");
    assert.equal(refs[0].heading, "Benchmarks");
    assert.equal(refs[0].absoluteSrc, "https://site.example/page/bench.png");
    assert.equal(refs[1].alt, "plain");
    assert.equal(refs[1].heading, "Benchmarks");
    assert.equal(refs[1].absoluteSrc, "https://img.example/a.gif");
  }, results);

  await testFunction("extractImageRefs caps at maxImages and strips link titles", () => {
    const markdown = "![a](a.png)\n![b](b.png)\n![c](c.png)\n![d](d.png)";
    const refs = extractImageRefs(markdown, new URL("https://x.example/"), 2);
    assert.equal(refs.length, 2);
    assert.equal(refs[0].src, "a.png");
    assert.equal(refs[1].src, "b.png");

    const titled = extractImageRefs('![x](img "Title")', new URL("https://x.example/"), 6);
    assert.equal(titled[0].src, "img");
  }, results);

  await testFunction("extractImageRefs keeps data URIs and skips src-less links", () => {
    const dataUri = `data:image/png;base64,${PNG_1PX}`;
    const markdown = `![d](${dataUri})\n![e]( )`;
    const refs = extractImageRefs(markdown, new URL("https://x.example/"), 6);
    assert.equal(refs.length, 1);
    assert.ok(refs[0].absoluteSrc.startsWith("data:image/png"));
  }, results);

  // ─── getImageLimits env overrides ──────────────────────────────────────────

  await testFunction("getImageLimits reads URL_READ_* env overrides", () => {
    envManager.set("URL_READ_MAX_IMAGES", "3");
    envManager.set("URL_READ_MAX_IMAGE_BYTES", "1024");
    envManager.set("URL_READ_MAX_TOTAL_IMAGE_BYTES", "2048");
    const l = getImageLimits();
    assert.equal(l.maxImages, 3);
    assert.equal(l.maxImageBytes, 1024);
    assert.equal(l.maxTotalBytes, 2048);
    envManager.set("URL_READ_MAX_IMAGES", "not-a-number");
    assert.equal(getImageLimits().maxImages, DEFAULT_MAX_IMAGES);
    envManager.restore();
  }, results);

  // ─── inlineImages ──────────────────────────────────────────────────────────

  await testFunction("inlineImages inlines data URIs without network access", async () => {
    const dataUri = `data:image/png;base64,${PNG_1PX}`;
    const refs = extractImageRefs(`![d](${dataUri})`, new URL("https://x.example/"), 6);
    const out = await inlineImages(refs, limits, 2000);
    assert.equal(out.length, 1);
    assert.equal(out[0].data, PNG_1PX);
    assert.equal(out[0].mimeType, "image/png");
  }, results);

  const server = await startImageServer([
    { path: "/ok.png", buffer: Buffer.from(PNG_1PX, "base64"), contentType: "image/png" },
    { path: "/no-type.png", buffer: Buffer.from(PNG_1PX, "base64") },
    { path: "/404.png", status: 404, body: "nope" },
    { path: "/plain.txt", body: "not an image", contentType: "text/plain" },
    { path: "/wrong-ctype.png", buffer: Buffer.from(PNG_1PX, "base64"), contentType: "text/plain" },
    { path: "/hang.png", hang: true },
  ]);
  envManager.set("MCP_HTTP_ALLOW_PRIVATE_URLS", "true");
  try {
    await testFunction("inlineImages downloads http images and marks failures with notes", async () => {
      const refs = extractImageRefs(
        [
          `![ok](${server.url}/ok.png)`,
          `![404](${server.url}/404.png)`,
          `![plain](${server.url}/plain.txt)`,
          `![wrong](${server.url}/wrong-ctype.png)`,
        ].join("\n"),
        new URL(server.url),
        6,
      );
      const out = await inlineImages(refs, limits, 2000);
      assert.equal(out.length, 4);
      assert.equal(out[0].data, PNG_1PX);
      assert.equal(out[0].mimeType, "image/png");
      assert.equal(out[1].note, "skipped: HTTP 404");
      assert.equal(out[2].note, "skipped: not an image (Content-Type text/plain)");
      assert.equal(out[2].data, undefined);
      // A .png extension is trusted even when the server mislabels Content-Type.
      assert.equal(out[3].data, PNG_1PX);
      assert.equal(out[3].mimeType, "image/png");
    }, results);

    await testFunction("inlineImages honors per-image and total byte budgets", async () => {
      const refs = extractImageRefs(
        `![big](${server.url}/ok.png)`,
        new URL(server.url),
        6,
      );
      const tightLimits: ImageLimits = { maxImages: 6, maxImageBytes: 4096, maxTotalBytes: 4 };
      const tiny: ImageLimits = { maxImages: 6, maxImageBytes: 10, maxTotalBytes: 100 };
      const out = await inlineImages(refs, tiny, 2000);
      assert.equal(out[0].note, "skipped: exceeds per-image limit of 10 B");
      const out2 = await inlineImages(refs, tightLimits, 2000);
      assert.equal(out2[0].note, "skipped: total image byte budget reached");
    }, results);
  } finally {
    await server.close();
    envManager.restore();
  }

  await testFunction("inlineImages times out without hanging the request", async () => {
    const hung = await startImageServer([{ path: "/hang.png", hang: true }]);
    envManager.set("MCP_HTTP_ALLOW_PRIVATE_URLS", "true");
    try {
      const refs = extractImageRefs(`![h](${hung.url}/hang.png)`, new URL(hung.url), 6);
      const start = Date.now();
      const out = await inlineImages(refs, limits, 300);
      assert.ok(Date.now() - start < 5000, "should finish promptly");
      assert.equal(out[0].data, undefined);
      assert.match(out[0].note ?? "", /timed out/);
    } finally {
      await hung.close();
      envManager.restore();
    }
  }, results);

  printTestSummary(results, "web-images tests");
  return results;
}

// Run if executed directly
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  runTests().then((results) => {
    process.exit(results.failed > 0 ? 1 : 0);
  }).catch(console.error);
}

export { runTests };
