const FAILURE_COOLDOWN_THRESHOLD = 3;
const FAILURE_COOLDOWN_MS = 60_000;

type InstanceHealth = {
  consecutiveFailures: number;
  cooledUntil: number;
};

const healthByInstance = new Map<string, InstanceHealth>();

function getActiveHealth(instanceUrl: string, now: number): InstanceHealth | undefined {
  const state = healthByInstance.get(instanceUrl);
  if (!state) {
    return undefined;
  }

  if (state.cooledUntil > 0 && state.cooledUntil <= now) {
    healthByInstance.delete(instanceUrl);
    return undefined;
  }

  return state;
}

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

export function redactSearxngInstanceUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (!url.username && !url.password) {
      return raw;
    }

    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return raw.replace(/^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/]*@/, "$1");
  }
}

export function stripSearxngInstanceUrlUserinfo(url: URL): URL {
  const stripped = new URL(url.toString());
  stripped.username = "";
  stripped.password = "";
  return stripped;
}

// `URL` stores userinfo percent-encoded, so decode before base64. A literal `%`
// the operator forgot to encode (e.g. `100%` instead of `100%25`) parses fine as
// a URL but makes decodeURIComponent throw URIError — fall back to the raw value
// instead of crashing request setup rather than guess at re-encoding.
function decodeUserinfoComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function getSearxngBasicAuthHeader(url: URL): string | undefined {
  if (url.username !== "" || url.password !== "") {
    const username = decodeUserinfoComponent(url.username);
    const password = decodeUserinfoComponent(url.password);
    return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  }

  const username = process.env.AUTH_USERNAME;
  const password = process.env.AUTH_PASSWORD;

  if (username && password) {
    const base64Auth = Buffer.from(`${username}:${password}`).toString('base64');
    return `Basic ${base64Auth}`;
  }

  return undefined;
}

export function isSearxngFanoutEnabled(): boolean {
  return process.env.SEARXNG_FANOUT === "true";
}

export function recordSearxngInstanceFailure(instanceUrl: string, now = Date.now()): void {
  const current = getActiveHealth(instanceUrl, now) ?? { consecutiveFailures: 0, cooledUntil: 0 };
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
  const state = getActiveHealth(instanceUrl, now);
  if (!state) {
    return false;
  }

  return state.cooledUntil > now;
}

export function getHealthySearxngInstances(instances: string[], now = Date.now()): string[] {
  return instances.filter((instanceUrl) => !isSearxngInstanceCooledDown(instanceUrl, now));
}

export function clearSearxngInstanceStateForTests(): void {
  healthByInstance.clear();
}
