/**
 * Shared strict-integer parsing and positive-integer normalization for
 * environment-configured numeric settings.
 */

export function parseStrictInteger(value: string): number | undefined {
  const trimmed = value.trim();
  if (!/^[+-]?\d+$/.test(trimmed)) {
    return undefined;
  }

  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  const parsed = parseStrictInteger(value);
  return parsed === undefined || parsed <= 0 ? fallback : parsed;
}

/**
 * Parses an optional strict integer and applies an inclusive safe range.
 * The caller owns any diagnostic so this helper remains deterministic and pure.
 */
export function parseBoundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): { value: number; invalid: boolean } {
  if (value === undefined || value.trim() === "") {
    return { value: fallback, invalid: false };
  }

  const parsed = parseStrictInteger(value);
  if (parsed === undefined || parsed < minimum || parsed > maximum) {
    return { value: fallback, invalid: true };
  }

  return { value: parsed, invalid: false };
}

export function normalizePositiveInteger(value: number, fallback: number): number {
  return !Number.isFinite(value) || !Number.isInteger(value) || value <= 0 ? fallback : value;
}
