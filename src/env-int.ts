/**
 * Shared positive-integer parsing/normalization for environment-configured
 * numeric settings. Used by both the URL cache (`cache.ts`) and the search
 * cache (`search-cache.ts`) so their env-parsing behavior stays identical.
 */

export function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) || parsed <= 0 ? fallback : parsed;
}

export function normalizePositiveInteger(value: number, fallback: number): number {
  return !Number.isFinite(value) || !Number.isInteger(value) || value <= 0 ? fallback : value;
}
