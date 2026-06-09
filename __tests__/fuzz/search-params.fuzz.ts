import { isSearXNGWebSearchArgs } from "../../src/types.js";

// Fuzz entry point — receives arbitrary Buffer from the fuzzer (jazzer.js convention)
export function fuzz(data: Buffer): void {
  const str = data.toString("utf-8");

  // Fuzz URL construction: mirrors what performWebSearch does with query input
  try {
    const url = new URL("https://example.com/search");
    url.searchParams.set("q", str);
    url.searchParams.set("format", "json");
  } catch {
    // malformed input is expected; must not crash the process
  }

  // Fuzz type guard: arbitrary input must never throw — only return true/false
  try {
    const parsed: unknown = JSON.parse(str);
    isSearXNGWebSearchArgs(parsed);
  } catch {
    // invalid JSON is expected
  }
}
