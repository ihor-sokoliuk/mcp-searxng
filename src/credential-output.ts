import { containsConfiguredCredential } from "./diagnostic-sanitizer.js";
import { MCPSearXNGError } from "./error-handler.js";

export const WITHHELD_CONTENT_MESSAGE = "Content withheld to protect configured authentication.";

/**
 * Withhold credential-bearing content instead of editing serialized JSON or
 * applying diagnostic truncation limits. Check complete content before any
 * output slicing; keep original request/config/cache identity inputs intact.
 */
export function assertSafeOutput(text: string): void {
  if (containsConfiguredCredential(text)) {
    throw new MCPSearXNGError(WITHHELD_CONTENT_MESSAGE);
  }
}
