import { Worker } from "node:worker_threads";

export const MAX_PDF_BYTES = 16 * 1024 * 1024;
export const MAX_PDF_PAGES = 500;
export const PDF_PARSE_TIMEOUT_MS = 30_000;
export const PDF_WORKER_RESOURCE_LIMITS = Object.freeze({
  maxOldGenerationSizeMb: 192,
  stackSizeMb: 4,
});
const MAX_CONCURRENT_PDF_WORKERS = 2;

export type PdfWorkerResult =
  | { version: 1; kind: "text"; text: string; totalPages: number; textBytes: number }
  | { version: 1; kind: "no_text"; totalPages: number }
  | { version: 1; kind: "text_too_large"; bytes: number }
  | { version: 1; kind: "too_many_pages"; totalPages: number }
  | { version: 1; kind: "password_protected" }
  | { version: 1; kind: "parse_error" }
  | { version: 1; kind: "external_fetch_attempt" };

export type PdfExtractionResult =
  | PdfWorkerResult
  | { version: 1; kind: "timeout" }
  | { version: 1; kind: "worker_failure" }
  | { version: 1; kind: "busy" };

interface PdfExtractionOptions {
  timeoutMs?: number;
  workerUrl?: URL;
}

let activePdfWorkers = 0;

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPdfWorkerResult(value: unknown): value is PdfWorkerResult {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const result = value as Record<string, unknown>;
  if (result.version !== 1 || typeof result.kind !== "string") {
    return false;
  }

  switch (result.kind) {
    case "text":
      return typeof result.text === "string"
        && isNonNegativeInteger(result.totalPages)
        && isNonNegativeInteger(result.textBytes);
    case "no_text":
    case "too_many_pages":
      return isNonNegativeInteger(result.totalPages);
    case "text_too_large":
      return isNonNegativeInteger(result.bytes);
    case "password_protected":
    case "parse_error":
    case "external_fetch_attempt":
      return true;
    default:
      return false;
  }
}

function defaultPdfWorkerUrl(): URL {
  if (import.meta.url.endsWith(".ts")) {
    return new URL("./pdf-worker-bootstrap.mjs", import.meta.url);
  }
  return new URL("./pdf-worker.js", import.meta.url);
}

export async function extractPdfText(
  bytes: Uint8Array,
  maxTextBytes: number,
  options: PdfExtractionOptions = {},
): Promise<PdfExtractionResult> {
  if (activePdfWorkers >= MAX_CONCURRENT_PDF_WORKERS) {
    return { version: 1, kind: "busy" };
  }

  activePdfWorkers++;
  const transferableBytes = bytes.slice();

  return await new Promise<PdfExtractionResult>((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(options.workerUrl ?? defaultPdfWorkerUrl(), {
        // `--input-type` is valid only for eval/stdin entrypoints and makes a
        // file-backed Worker fail during startup when inherited from a caller.
        execArgv: process.execArgv.filter((argument) => argument !== "--input-type=module"),
        workerData: {
          version: 1,
          pdfBytes: transferableBytes.buffer,
          maxTextBytes,
        },
        transferList: [transferableBytes.buffer],
        resourceLimits: PDF_WORKER_RESOURCE_LIMITS,
      });
    } catch {
      activePdfWorkers--;
      resolve({ version: 1, kind: "worker_failure" });
      return;
    }

    let settled = false;
    const timeoutId = setTimeout(() => {
      finish({ version: 1, kind: "timeout" });
    }, options.timeoutMs ?? PDF_PARSE_TIMEOUT_MS);

    function finish(result: PdfExtractionResult): void {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutId);
      worker.removeAllListeners();

      const releaseSlot = (): void => {
        activePdfWorkers--;
        resolve(result);
      };
      try {
        void worker.terminate().then(releaseSlot, releaseSlot);
      } catch {
        // `terminate()` normally returns a promise, but a synchronous failure
        // must not retain the process-wide concurrency slot.
        releaseSlot();
      }
    }

    worker.once("message", (message: unknown) => {
      finish(
        isPdfWorkerResult(message)
          ? message
          : { version: 1, kind: "worker_failure" },
      );
    });
    worker.once("error", () => {
      finish({ version: 1, kind: "worker_failure" });
    });
    worker.once("exit", () => {
      finish({ version: 1, kind: "worker_failure" });
    });
  });
}
