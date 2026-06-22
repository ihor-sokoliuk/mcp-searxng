const FAILURE_COOLDOWN_THRESHOLD = 3;
const FAILURE_COOLDOWN_MS = 60_000;

type InstanceHealth = {
  consecutiveFailures: number;
  cooledUntil: number;
};

const healthByInstance = new Map<string, InstanceHealth>();

export function parseSearxngUrls(raw: string | undefined = process.env.SEARXNG_URL): string[] {
  if (raw === undefined) {
    return [];
  }

  return raw
    .split(";")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

export function getSearxngInstances(): string[] {
  return parseSearxngUrls();
}

export function getPrimarySearxngInstance(): string | undefined {
  return getSearxngInstances()[0];
}

export function validateSearxngInstanceUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) {
      return `SEARXNG_URL invalid protocol for "${value}": ${url.protocol}`;
    }
  } catch {
    return `SEARXNG_URL invalid format: ${value}`;
  }

  return null;
}

export function isSearxngFanoutEnabled(): boolean {
  return process.env.SEARXNG_FANOUT === "true";
}

export function recordSearxngInstanceFailure(instanceUrl: string, now = Date.now()): void {
  const current = healthByInstance.get(instanceUrl) ?? { consecutiveFailures: 0, cooledUntil: 0 };
  const consecutiveFailures = current.consecutiveFailures + 1;
  healthByInstance.set(instanceUrl, {
    consecutiveFailures,
    cooledUntil: consecutiveFailures >= FAILURE_COOLDOWN_THRESHOLD ? now + FAILURE_COOLDOWN_MS : current.cooledUntil,
  });
}

export function recordSearxngInstanceSuccess(instanceUrl: string): void {
  healthByInstance.delete(instanceUrl);
}

export function isSearxngInstanceCooledDown(instanceUrl: string, now = Date.now()): boolean {
  const state = healthByInstance.get(instanceUrl);
  if (!state || state.cooledUntil <= now) {
    return false;
  }

  return true;
}

export function getHealthySearxngInstances(instances: string[], now = Date.now()): string[] {
  return instances.filter((instanceUrl) => !isSearxngInstanceCooledDown(instanceUrl, now));
}

export function clearSearxngInstanceStateForTests(): void {
  healthByInstance.clear();
}
