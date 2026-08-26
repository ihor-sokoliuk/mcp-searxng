// Image extraction and inlining for web_url_read (images: "inline").
//
// Extracts image links from the converted markdown (NodeHtmlMarkdown emits
// <img> tags as ![alt](src) links) and optionally downloads the images so
// the MCP result can carry them as image content blocks alongside the
// markdown. All limits are bounded so a single page cannot blow up the
// model context.
import { fetch as undiciFetch } from "undici";
import { createProxyAgent, createUrlReaderAgent, ProxyType } from "./proxy.js";
import { assertUrlAllowed, isUrlSecurityPolicyDnsError } from "./url-security.js";
import { parsePositiveInteger } from "./env-int.js";

export type ImageMode = "none" | "links" | "inline";

export interface ImageRef {
  /** src as it appears in the markdown link (relative or absolute). */
  src: string;
  /** src resolved against the base URL (data: URIs pass through). */
  absoluteSrc: string;
  /** alt text, empty string when absent. */
  alt: string;
  /** Text of the nearest preceding markdown heading, empty when none. */
  heading: string;
}

export interface InlinedImage extends ImageRef {
  /** base64 image payload when inlined successfully. */
  data?: string;
  /** Resolved MIME type when inlined successfully. */
  mimeType?: string;
  /** Why the image was left as a link instead of inlined. */
  note?: string;
}

export interface ImageLimits {
  maxImages: number;
  maxImageBytes: number;
  maxTotalBytes: number;
}

export const DEFAULT_MAX_IMAGES = 6;
export const DEFAULT_MAX_IMAGE_BYTES = 512 * 1024;
export const DEFAULT_MAX_TOTAL_IMAGE_BYTES = 1.5 * 1024 * 1024;

export function getImageLimits(): ImageLimits {
  return {
    maxImages: parsePositiveInteger(process.env.URL_READ_MAX_IMAGES, DEFAULT_MAX_IMAGES),
    maxImageBytes: parsePositiveInteger(process.env.URL_READ_MAX_IMAGE_BYTES, DEFAULT_MAX_IMAGE_BYTES),
    maxTotalBytes: parsePositiveInteger(process.env.URL_READ_MAX_TOTAL_IMAGE_BYTES, DEFAULT_MAX_TOTAL_IMAGE_BYTES),
  };
}

const HEADING_LINE = /^#{1,6}\s+(.*)$/;
// Strip optional ATX closing hashes: "## Foo ##" -> "Foo"
const stripClosingHashes = (text: string): string => text.replace(/\s+#+\s*$/, "").trim();
// ![alt](src) — group 1 = alt text, group 2 = the link target up to the first ")"
const IMAGE_LINK = /!\[([^\]]*)\]\(([^)]+)\)/g;
// Split a link target into (src, optional "title"); src is the first token.
const splitImageTarget = (target: string): string => target.trim().split(/\s+/)[0] ?? "";

/**
 * Collect up to `maxImages` image references in document order, tracking the
 * nearest preceding markdown heading for context. data: URIs are included;
 * they can be inlined without a network fetch.
 */
export function extractImageRefs(markdown: string, baseUrl: URL, maxImages: number): ImageRef[] {
  const refs: ImageRef[] = [];
  let heading = "";
  for (const line of markdown.split("\n")) {
    const headingMatch = HEADING_LINE.exec(line);
    if (headingMatch) {
      heading = stripClosingHashes(headingMatch[1]);
    }
    IMAGE_LINK.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = IMAGE_LINK.exec(line)) !== null) {
      const alt = match[1].trim();
      const src = splitImageTarget(match[2]);
      if (!src) continue;
      let absoluteSrc = src;
      try {
        absoluteSrc = new URL(src, baseUrl).href;
      } catch {
        absoluteSrc = src;
      }
      refs.push({
        src,
        absoluteSrc,
        alt,
        heading,
      });
      if (refs.length >= maxImages) {
        return refs;
      }
    }
  }
  return refs;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function parseDataUri(uri: string): { data: string; mimeType: string; bytes: number } | null {
  const base64 = /^data:([a-z0-9/+.-]+);base64,(.*)$/is.exec(uri);
  if (base64) {
    return {
      data: base64[2],
      mimeType: base64[1] || "application/octet-stream",
      bytes: Math.floor((base64[2].length * 3) / 4),
    };
  }
  const plain = /^data:([^,]*),(.*)$/s.exec(uri);
  if (plain && !plain[1].toLowerCase().includes(";base64")) {
    const payload = Buffer.from(decodeURIComponent(plain[2]), "utf8");
    return {
      data: payload.toString("base64"),
      mimeType: plain[1] || "application/octet-stream",
      bytes: payload.byteLength,
    };
  }
  return null;
}

const IMAGE_TYPE_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  avif: "image/avif",
};

type FetchedImage =
  | { ok: true; bytes: Uint8Array; mimeType: string }
  | { ok: false; reason: string };

async function fetchImageBytes(
  url: string,
  maxBytes: number,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<FetchedImage> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "unparseable URL" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: "unsupported protocol" };
  }
  try {
    assertUrlAllowed(parsed);
  } catch {
    return { ok: false, reason: "blocked by URL security policy" };
  }

  const proxyAgent = createProxyAgent(url, ProxyType.URL_READER);
  const dispatcher = proxyAgent ?? createUrlReaderAgent();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onOuterAbort = () => controller.abort();
  signal?.addEventListener("abort", onOuterAbort, { once: true });
  try {
    const requestOptions: Record<string, unknown> = {
      redirect: "follow",
      signal: controller.signal,
    };
    if (dispatcher) requestOptions.dispatcher = dispatcher;
    const userAgent = process.env.URL_READER_USER_AGENT || process.env.USER_AGENT;
    if (userAgent) requestOptions.headers = { "User-Agent": userAgent };

    const response = await (undiciFetch as unknown as typeof fetch)(url, requestOptions);
    if (!response.ok) {
      return { ok: false, reason: `HTTP ${response.status}` };
    }

    const contentType = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    let mimeType = contentType;
    if (!mimeType.startsWith("image/")) {
      const extension = parsed.pathname.split(".").pop()?.toLowerCase() ?? "";
      mimeType = IMAGE_TYPE_BY_EXTENSION[extension] ?? "";
    }
    if (!mimeType.startsWith("image/")) {
      return { ok: false, reason: `not an image (Content-Type ${contentType || "unknown"})` };
    }

    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
      total += chunk.byteLength;
      if (total > maxBytes) {
        return { ok: false, reason: `exceeds per-image limit of ${formatBytes(maxBytes)}` };
      }
      chunks.push(chunk);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { ok: true, bytes, mimeType };
  } catch (error: any) {
    if (isUrlSecurityPolicyDnsError(error)) {
      return { ok: false, reason: "blocked by URL security policy" };
    }
    return {
      ok: false,
      reason: error?.name === "AbortError"
        ? `timed out after ${timeoutMs} ms`
        : error?.message ?? "fetch failed",
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onOuterAbort);
  }
}

/**
 * Download the images for the given refs (in order) up to the byte budgets.
 * Failures never throw: the image is kept as a markdown link with a `note`.
 */
export async function inlineImages(
  refs: ImageRef[],
  limits: ImageLimits,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<InlinedImage[]> {
  const out: InlinedImage[] = [];
  let totalBytes = 0;
  for (const ref of refs.slice(0, limits.maxImages)) {
    const image: InlinedImage = { ...ref };
    try {
      if (ref.absoluteSrc.startsWith("data:")) {
        const parsed = parseDataUri(ref.absoluteSrc);
        if (!parsed || !parsed.mimeType.startsWith("image/")) {
          image.note = "skipped: not a decodable image data URI";
          out.push(image);
          continue;
        }
        if (parsed.bytes > limits.maxImageBytes) {
          image.note = `skipped: ${formatBytes(parsed.bytes)} exceeds per-image limit`;
          out.push(image);
          continue;
        }
        if (totalBytes + parsed.bytes > limits.maxTotalBytes) {
          image.note = "skipped: total image byte budget reached";
          out.push(image);
          continue;
        }
        image.data = parsed.data;
        image.mimeType = parsed.mimeType;
        totalBytes += parsed.bytes;
      } else {
        const fetched = await fetchImageBytes(ref.absoluteSrc, limits.maxImageBytes, timeoutMs, signal);
        if (!fetched.ok) {
          image.note = `skipped: ${fetched.reason}`;
          out.push(image);
          continue;
        }
        if (totalBytes + fetched.bytes.byteLength > limits.maxTotalBytes) {
          image.note = "skipped: total image byte budget reached";
          out.push(image);
          continue;
        }
        image.data = Buffer.from(fetched.bytes).toString("base64");
        image.mimeType = fetched.mimeType;
        totalBytes += fetched.bytes.byteLength;
      }
    } catch (error: any) {
      image.note = `skipped: ${error?.message ?? "image fetch failed"}`;
    }
    out.push(image);
  }
  return out;
}
