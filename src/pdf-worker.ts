import { parentPort, workerData } from "node:worker_threads";
import { MAX_PDF_PAGES, type PdfWorkerResult } from "./pdf-reader.js";
import { installPdfNetworkGuards } from "./pdf-network-guard.js";

interface PdfWorkerInput {
  version: 1;
  pdfBytes: ArrayBuffer;
  maxTextBytes: number;
}

export const PDF_DOCUMENT_OPTIONS = Object.freeze({
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

type PdfDocumentProxy = Awaited<
  ReturnType<(typeof import("unpdf"))["getDocumentProxy"]>
>;
type PdfLoadingTask = Pick<PdfDocumentProxy["loadingTask"], "destroy">;
type PdfPageProxy = Awaited<ReturnType<PdfDocumentProxy["getPage"]>>;
type PdfDocumentLoader = (
  pdfBytes: Uint8Array,
  options: typeof PDF_DOCUMENT_OPTIONS,
) => Promise<PdfDocumentProxy>;

export async function teardownPdfLoadingTask(loadingTask: PdfLoadingTask | undefined): Promise<void> {
  try {
    await loadingTask?.destroy();
  } catch {
    // The extraction result is authoritative; teardown failures stay inside the worker.
  }
}

function containsExternalFetchMarker(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 4; depth++) {
    if (!current || typeof current !== "object") {
      return false;
    }
    const candidate = current as { name?: unknown; message?: unknown; cause?: unknown };
    if (
      candidate.name === "ExternalFetchAttemptError"
      || String(candidate.message).includes("PDF_EXTERNAL_FETCH_ATTEMPT")
    ) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

function isPasswordError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && (error as { name?: unknown }).name === "PasswordException";
}

function normalizeMergedText(texts: string[]): string {
  return texts
    .join("\n")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function removeUnsafeControlCharacters(text: string): string {
  return text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

function isPdfWorkerInput(value: unknown): value is PdfWorkerInput {
  if (!value || typeof value !== "object") {
    return false;
  }
  const input = value as Partial<PdfWorkerInput>;
  return input.version === 1
    && input.pdfBytes instanceof ArrayBuffer
    && Number.isSafeInteger(input.maxTextBytes)
    && (input.maxTextBytes ?? 0) > 0;
}

function renderTextItem(item: unknown): string {
  if (!item || typeof item !== "object" || !("str" in item) || typeof item.str !== "string") {
    return "";
  }
  return item.str + ("hasEOL" in item && item.hasEOL ? "\n" : "");
}

async function readPageText(page: PdfPageProxy): Promise<string> {
  try {
    const content = await page.getTextContent();
    const rawText = content.items.map(renderTextItem).join("");
    return normalizeMergedText([removeUnsafeControlCharacters(rawText)]);
  } finally {
    page.cleanup();
  }
}

async function extractDocumentText(
  pdf: PdfDocumentProxy,
  maxTextBytes: number,
): Promise<PdfWorkerResult> {
  if (pdf.numPages > MAX_PDF_PAGES) {
    return { version: 1, kind: "too_many_pages", totalPages: pdf.numPages };
  }

  const pageTexts: string[] = [];
  const encoder = new TextEncoder();
  let textBytes = 0;
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
    const pageText = await readPageText(await pdf.getPage(pageNumber));
    if (pageText === "") {
      continue;
    }
    textBytes += encoder.encode(pageText).byteLength + (pageTexts.length > 0 ? 1 : 0);
    if (textBytes > maxTextBytes) {
      return { version: 1, kind: "text_too_large", bytes: textBytes };
    }
    pageTexts.push(pageText);
  }

  const text = pageTexts.join("\n");
  return text === ""
    ? { version: 1, kind: "no_text", totalPages: pdf.numPages }
    : { version: 1, kind: "text", text, totalPages: pdf.numPages, textBytes };
}

function classifyParserError(error: unknown): PdfWorkerResult {
  if (containsExternalFetchMarker(error)) {
    return { version: 1, kind: "external_fetch_attempt" };
  }
  return isPasswordError(error)
    ? { version: 1, kind: "password_protected" }
    : { version: 1, kind: "parse_error" };
}

async function loadPdfDocument(
  pdfBytes: Uint8Array,
  options: typeof PDF_DOCUMENT_OPTIONS,
): Promise<PdfDocumentProxy> {
  const { getDocumentProxy } = await import("unpdf");
  return getDocumentProxy(pdfBytes, options);
}

export async function extractPdfWorkerInput(
  input: unknown,
  loadDocument: PdfDocumentLoader = loadPdfDocument,
): Promise<PdfWorkerResult> {
  if (!isPdfWorkerInput(input)) {
    return { version: 1, kind: "parse_error" };
  }

  // The document loader receives bytes rather than a URL, so no target-derived
  // filesystem path exists. Block the Node fetch, HTTP(S), TCP, and TLS
  // primitives used by the parser as a second layer while parsing untrusted
  // document content.
  const restoreNetwork = installPdfNetworkGuards();

  let pdf: PdfDocumentProxy | undefined;
  try {
    // Import after the guards are active so parser dependencies cannot retain
    // unguarded references to Node network primitives during module loading.
    pdf = await loadDocument(new Uint8Array(input.pdfBytes), PDF_DOCUMENT_OPTIONS);
    return await extractDocumentText(pdf, input.maxTextBytes);
  } catch (error) {
    return classifyParserError(error);
  } finally {
    await teardownPdfLoadingTask(pdf?.loadingTask);
    restoreNetwork();
  }
}

const outputPort = parentPort;
if (outputPort) {
  void extractPdfWorkerInput(workerData).then((result) => outputPort.postMessage(result));
}
