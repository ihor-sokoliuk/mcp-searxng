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

export const STATEFUL_LIFECYCLE_EVENTS = [
  "capacity_rejection", "idle_reclaim", "initialize_timeout", "post_timeout",
  "close_failure", "forced_shutdown",
] as const;
type StatefulLifecycleEvent = typeof STATEFUL_LIFECYCLE_EVENTS[number];

/** No caller-controlled payloads enter the lifecycle diagnostic channel. */
export function createStatefulLifecycleDiagnostics() {
  const pending = new Map<StatefulLifecycleEvent, { count: number; timer?: NodeJS.Timeout }>();
  let draining = false;
  let closed = false;
  const emit = (event: StatefulLifecycleEvent, count: number): void => {
    try { writeDiagnostic("warn", `Stateful HTTP lifecycle: ${event}`, { count }); }
    catch { /* Diagnostic sinks must not affect HTTP or cleanup decisions. */ }
  };
  const flush = (): void => {
    for (const [event, entry] of pending) {
      clearTimeout(entry.timer);
      if (entry.count) emit(event, entry.count);
    }
    pending.clear();
  };
  return {
    record(event: StatefulLifecycleEvent): void {
      if (closed || !STATEFUL_LIFECYCLE_EVENTS.includes(event)) return;
      const entry = pending.get(event);
      if (entry) { entry.count = Math.min(Number.MAX_SAFE_INTEGER, entry.count + 1); return; }
      const next: { count: number; timer?: NodeJS.Timeout } = { count: 0 };
      pending.set(event, next);
      if (!draining) {
        next.timer = setTimeout(() => {
          pending.delete(event);
          if (next.count) emit(event, next.count);
        }, 60000);
        next.timer.unref();
      }
      emit(event, 1);
    },
    drain(): void { draining = true; flush(); },
    close(): void { closed = true; flush(); },
  };
}
