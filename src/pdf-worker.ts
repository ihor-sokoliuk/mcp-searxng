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

async function extract(): Promise<PdfWorkerResult> {
  const input = workerData as PdfWorkerInput;
  if (
    input.version !== 1
    || !(input.pdfBytes instanceof ArrayBuffer)
    || !Number.isSafeInteger(input.maxTextBytes)
    || input.maxTextBytes <= 0
  ) {
    return { version: 1, kind: "parse_error" };
  }

  // The document loader receives bytes rather than a URL, so no target-derived
  // filesystem path exists. Block the network primitives available to Node as
  // a second layer while parsing untrusted document content.
  const restoreNetwork = installPdfNetworkGuards();

  let pdf: PdfDocumentProxy | undefined;
  try {
    // Import after the guards are active so parser dependencies cannot retain
    // unguarded references to Node network primitives during module loading.
    const { getDocumentProxy } = await import("unpdf");
    pdf = await getDocumentProxy(new Uint8Array(input.pdfBytes), PDF_DOCUMENT_OPTIONS);

    if (pdf.numPages > MAX_PDF_PAGES) {
      return { version: 1, kind: "too_many_pages", totalPages: pdf.numPages };
    }

    const pageTexts: string[] = [];
    const encoder = new TextEncoder();
    let textBytes = 0;
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      try {
        const content = await page.getTextContent();
        const pageText = normalizeMergedText([removeUnsafeControlCharacters(content.items
          .map((item) => "str" in item && typeof item.str === "string"
            ? item.str + (item.hasEOL ? "\n" : "")
            : "")
          .join(""))]);
        if (pageText !== "") {
          const pageBytes = encoder.encode(pageText).byteLength;
          textBytes += pageBytes + (pageTexts.length > 0 ? 1 : 0);
          if (textBytes > input.maxTextBytes) {
            return { version: 1, kind: "text_too_large", bytes: textBytes };
          }
          pageTexts.push(pageText);
        }
      } finally {
        page.cleanup();
      }
    }

    const text = pageTexts.join("\n");
    if (text === "") {
      return { version: 1, kind: "no_text", totalPages: pdf.numPages };
    }

    return { version: 1, kind: "text", text, totalPages: pdf.numPages, textBytes };
  } catch (error) {
    if (containsExternalFetchMarker(error)) {
      return { version: 1, kind: "external_fetch_attempt" };
    }
    if (isPasswordError(error)) {
      return { version: 1, kind: "password_protected" };
    }
    return { version: 1, kind: "parse_error" };
  } finally {
    restoreNetwork();
    try {
      await pdf?.destroy();
    } catch {
      // The extraction result is authoritative; teardown failures stay inside the worker.
    }
  }
}

const outputPort = parentPort;
if (outputPort) {
  void extract().then((result) => outputPort.postMessage(result));
}
