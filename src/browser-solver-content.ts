import { Buffer } from "node:buffer";
import { parse } from "node-html-parser";
import type { BrowserSolverSolution } from "./browser-solver.js";
import type { BrowserSolverProvider } from "./browser-solver-config.js";
import { createContentError } from "./error-handler.js";
import { assertSafeOutput } from "./credential-output.js";
import { MAX_PDF_BYTES } from "./pdf-reader.js";

export const MAX_SOLVER_HTML_BYTES = 5 * 1024 * 1024;

export function browserSolverEnvelopeLimit(maxBytes: number): number {
  // JSON may escape each ASCII byte as six characters (e.g. \\u003c).
  const htmlEnvelope = 6 * Math.min(maxBytes, MAX_SOLVER_HTML_BYTES);
  const pdfEnvelope = 4 * Math.ceil(Math.min(maxBytes, MAX_PDF_BYTES) / 3);
  return Math.max(htmlEnvelope, pdfEnvelope) + 256 * 1024;
}

function solutionMediaType(solution: BrowserSolverSolution): string | undefined {
  // Byparr's contentType describes its returned body (headers may describe the
  // original response instead). FlareSolverr often supplies no response headers.
  const header = Object.entries(solution.headers ?? {})
    .find(([name]) => name.toLowerCase() === "content-type")?.[1];
  const value = solution.contentType ?? header;
  return typeof value === "string" ? value.split(";")[0].trim().toLowerCase() : undefined;
}

function isBrowserDocumentWrapper(html: string): boolean {
  const document = parse(html);
  const body = document.querySelector("body");
  return (body !== null && isRawDocumentBody(body)) || isPdfDocument(document);
}

function isPdfDocument(document: ReturnType<typeof parse>): boolean {
  return document.querySelector("pdf-viewer") !== null
    || document.querySelectorAll("link").some(element =>
      element.getAttribute("href")?.startsWith("chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/"))
    || document.querySelectorAll("embed,object,iframe").some(element => {
      const type = element.getAttribute("type")?.toLowerCase();
      return type === "application/pdf" || type === "application/x-google-chrome-pdf";
    });
}

function isRawDocumentBody(body: ReturnType<typeof parse>): boolean {
  // Chrome/Firefox wrap raw text, JSON and images in a generated HTML document.
  // An HTML-only solver response cannot establish the original media type, so
  // keep replay authoritative for these ambiguous shapes.
  const children = body.children;
  if (children.length === 1 && ["PRE", "IMG"].includes(children[0].tagName)) return true;
  return body.querySelector(".json-formatter-container") !== null;
}

function decodePdf(body: string, limit: number, url: string): Uint8Array<ArrayBuffer> {
  if (body.length > Math.ceil(limit / 3) * 4) {
    throw createContentError("Browser solver PDF exceeds the content byte limit.", url);
  }
  // Buffer's base64 decoder is permissive: require canonical, padded base64.
  if (body.length % 4 !== 0) {
    throw createContentError("Browser solver returned malformed PDF base64.", url);
  }
  const bytes = Buffer.from(body, "base64");
  if (bytes.toString("base64") !== body || bytes.byteLength > limit
      || bytes.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw createContentError("Browser solver returned invalid PDF content.", url);
  }
  return new Uint8Array(bytes);
}

function htmlContentResponse(body: string, solution: BrowserSolverSolution, maxBytes: number): Response | null {
  if (Buffer.byteLength(body, "utf8") > Math.min(maxBytes, MAX_SOLVER_HTML_BYTES)) {
    throw createContentError("Browser solver content exceeds the content byte limit.", solution.url);
  }
  if (!isHtmlBody(body, solutionMediaType(solution))) return null;
  if (body.slice(0, 1024).includes("\0")) {
    throw createContentError("Browser solver returned binary HTML content.", solution.url);
  }
  assertSafeOutput(body);
  if (isBrowserDocumentWrapper(body)) return null;
  return new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
}

function isHtmlBody(body: string, mediaType?: string): boolean {
  if (mediaType) return mediaType === "text/html" || mediaType === "application/xhtml+xml";
  const prefix = body.trimStart().slice(0, 20).toLowerCase();
  return prefix.startsWith("<!doctype html")
    || (prefix.startsWith("<html") && [">", " ", "\t", "\r", "\n", "\f"].includes(prefix[5]));
}

/** A null result requires guarded replay; invalid content fails closed. */
export function browserSolverContentResponse(
  provider: BrowserSolverProvider, solution: BrowserSolverSolution, maxBytes: number,
): Response | null {
  const body = solution.response;
  if (!body?.trim()) return null;
  if (solutionMediaType(solution) !== "application/pdf") return htmlContentResponse(body, solution, maxBytes);
  if (provider !== "byparr") return null;
  const bytes = decodePdf(body, Math.min(maxBytes, MAX_PDF_BYTES), solution.url);
  return new Response(bytes, { headers: { "content-type": "application/pdf" } });
}
