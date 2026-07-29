/**
 * Environment Variable Utilities
 * 
 * Helpers for managing environment variables in tests
 */

export interface EnvSnapshot {
  [key: string]: string | undefined;
}

export type ProcessEnvSnapshot = Record<string, string>;

/**
 * Snapshot the complete process environment for per-test isolation.
 */
export function snapshotProcessEnv(): ProcessEnvSnapshot {
  const snapshot = Object.create(null) as ProcessEnvSnapshot;
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      snapshot[key] = value;
    }
  }
  return snapshot;
}

/**
 * Restore the complete process environment, removing keys added after the snapshot.
 */
export function restoreProcessEnv(snapshot: ProcessEnvSnapshot): void {
  for (const key of Object.keys(process.env)) {
    if (!Object.hasOwn(snapshot, key)) {
      delete process.env[key];
    }
  }

  for (const [key, value] of Object.entries(snapshot)) {
    process.env[key] = value;
  }
}

/**
 * Save current environment variables
 */
export function saveEnv(keys: string[]): EnvSnapshot {
  const snapshot: EnvSnapshot = {};
  for (const key of keys) {
    snapshot[key] = process.env[key];
  }
  return snapshot;
}

/**
 * Restore environment variables from snapshot
 */
export function restoreEnv(snapshot: EnvSnapshot): void {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

/**
 * Clear specified environment variables
 */
export function clearEnv(keys: string[]): void {
  for (const key of keys) {
    delete process.env[key];
  }
}

/**
 * Set environment variables
 */
export function setEnv(vars: Record<string, string>): void {
  for (const [key, value] of Object.entries(vars)) {
    process.env[key] = value;
  }
}

/**
 * Manage environment for a test
 */
export class EnvManager {
  private snapshots: Map<string, string | undefined> = new Map();

  save(...keys: string[]): void {
    for (const key of keys) {
      if (!this.snapshots.has(key)) {
        this.snapshots.set(key, process.env[key]);
      }
    }
  }

  set(key: string, value: string): void {
    this.save(key);
    process.env[key] = value;
  }

  delete(key: string): void {
    this.save(key);
    delete process.env[key];
  }

  restore(): void {
    for (const [key, value] of this.snapshots.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    this.snapshots.clear();
  }
}
