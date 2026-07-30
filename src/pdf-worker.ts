import { parentPort, workerData } from "node:worker_threads";
import { getDocumentProxy } from "unpdf";
import { MAX_PDF_PAGES, type PdfWorkerResult } from "./pdf-reader.js";

interface PdfWorkerInput {
  version: 1;
  pdfBytes: ArrayBuffer;
  maxTextBytes: number;
}

class ExternalFetchAttemptError extends Error {
  constructor() {
    super("PDF_EXTERNAL_FETCH_ATTEMPT");
    this.name = "ExternalFetchAttemptError";
  }
}

function containsExternalFetchMarker(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 4 && current; depth++) {
    if (
      typeof current === "object"
      && current !== null
      && (
        (current as { name?: unknown }).name === "ExternalFetchAttemptError"
        || String((current as { message?: unknown }).message).includes("PDF_EXTERNAL_FETCH_ATTEMPT")
      )
    ) {
      return true;
    }
    current = typeof current === "object" && current !== null
      ? (current as { cause?: unknown }).cause
      : undefined;
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

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new ExternalFetchAttemptError();
  };

  let pdf: Awaited<ReturnType<typeof getDocumentProxy>> | undefined;
  try {
    pdf = await getDocumentProxy(new Uint8Array(input.pdfBytes), {
      isEvalSupported: false,
      enableXfa: false,
      useSystemFonts: false,
      disableFontFace: true,
      disableAutoFetch: true,
      disableStream: true,
      useWorkerFetch: false,
      verbosity: 0,
    });

    if (pdf.numPages > MAX_PDF_PAGES) {
      return { version: 1, kind: "too_many_pages", totalPages: pdf.numPages };
    }

    const pageTexts: string[] = [];
    const encoder = new TextEncoder();
    let provisionalBytes = 0;
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      try {
        const content = await page.getTextContent();
        const pageText = content.items
          .map((item) => "str" in item && typeof item.str === "string"
            ? item.str + (item.hasEOL ? "\n" : "")
            : "")
          .join("");
        pageTexts.push(pageText);
        provisionalBytes += encoder.encode(pageText).byteLength + (pageNumber > 1 ? 1 : 0);
        if (provisionalBytes > input.maxTextBytes) {
          return { version: 1, kind: "text_too_large", bytes: provisionalBytes };
        }
      } finally {
        page.cleanup();
      }
    }

    const text = normalizeMergedText(pageTexts);
    if (text === "") {
      return { version: 1, kind: "no_text", totalPages: pdf.numPages };
    }

    const textBytes = encoder.encode(text).byteLength;
    if (textBytes > input.maxTextBytes) {
      return { version: 1, kind: "text_too_large", bytes: textBytes };
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
    globalThis.fetch = originalFetch;
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
