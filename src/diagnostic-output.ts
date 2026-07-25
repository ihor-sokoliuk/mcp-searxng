import {
  sanitizeDiagnosticValue,
  sanitizeErrorForTransport,
} from "./diagnostic-sanitizer.js";

export type DiagnosticLevel = "log" | "warn" | "error";

export function writeDiagnostic(
  level: DiagnosticLevel,
  ...values: unknown[]
): void {
  const sanitized = values.map((value) => (
    value instanceof Error
      ? sanitizeErrorForTransport(value)
      : sanitizeDiagnosticValue(value)
  ));
  console[level](...sanitized);
}
