import { PROXY_ENVIRONMENT_KEYS } from "./proxy-environment.js";

const REDACTED = "[redacted]";
const REDACTED_DIAGNOSTIC = "[redacted diagnostic]";
const UNAVAILABLE = "[unavailable]";
const MAX_DEPTH = 12;
const MAX_COLLECTION_ITEMS = 100;
const MAX_STRING_LENGTH = 64 * 1024;

type CredentialSnapshot = {
  replacements: readonly string[];
  normalizedSecrets: readonly string[];
  configuredUrls: ReadonlyMap<string, string>;
};

let snapshot: CredentialSnapshot | undefined;

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function lowerPercentHex(value: string): string {
  return value.replace(/%[0-9a-f]{2}/gi, (match) => match.toLowerCase());
}

// Inspect original text and intermediate forms: decoding a neighboring escape
// must never hide an originally present secret. Four bounded rounds also cover
// two JSON layers combined with two URI layers, in either order. No operational
// value is modified and no attempt is made to decode arbitrary obfuscation.
function secretTextForms(value: string): string[] {
  const forms = [value];
  for (let pass = 0; pass < 4; pass++) {
    value = value.replace(/[\x5c](?:u[0-9a-fA-F]{4}|[\x22\x5cbfnrt\x2f])/g,
      (escape) => JSON.parse(`"${escape}"`) as string);
    forms.push(value);
    value = value.replace(/%[0-9a-fA-F]{2}/g,
      (escape) => String.fromCharCode(Number.parseInt(escape.slice(1), 16)));
    forms.push(value);
  }
  return forms;
}

function addUriForms(values: Set<string>, value: string): void {
  if (value === "") return;
  values.add(value);
  const once = encodeURIComponent(value);
  const twice = encodeURIComponent(once);
  values.add(once);
  values.add(lowerPercentHex(once));
  values.add(twice);
  values.add(lowerPercentHex(twice));
}

function addBasicForms(
  values: Set<string>,
  username: string,
  password: string,
): void {
  if (username === "" && password === "") return;
  const pair = `${username}:${password}`;
  addUriForms(values, pair);

  const standard = Buffer.from(pair).toString("base64");
  const standardUnpadded = standard.replace(/=+$/u, "");
  const urlSafePadded = standard.replace(/\+/gu, "-").replace(/\//gu, "_");
  const urlSafeUnpadded = urlSafePadded.replace(/=+$/u, "");
  for (const token of [
    standard,
    standardUnpadded,
    urlSafePadded,
    urlSafeUnpadded,
  ]) {
    values.add(token);
    values.add(`Basic ${token}`);
  }
}

function redactUrl(raw: string, proxy: boolean): string {
  try {
    const url = new URL(raw);
    // A bare user:password@host can parse as an opaque custom scheme; clearing
    // URL.userinfo would leave the entire credential-bearing path untouched.
    // Misplaced separators can also put credentials in a path/query/fragment.
    if (!["http:", "https:"].includes(url.protocol) || url.pathname.includes("@") || (proxy && (
      url.pathname !== "/" || url.search !== "" || url.hash !== ""
    ))) {
      return REDACTED_DIAGNOSTIC;
    }
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return REDACTED_DIAGNOSTIC;
  }
}

function captureSnapshot(env: NodeJS.ProcessEnv): CredentialSnapshot {
  const replacements = new Set<string>();
  const configuredUrls = new Map<string, string>();
  const rawUrls = env.SEARXNG_URL?.split(";")
    .map((entry) => entry.trim())
    .filter(Boolean) ?? [];
  // Keep the exact proxy setting: even an unparseable value must be removed
  // from diagnostics. This snapshot never changes the operational setting.
  const proxyUrls = PROXY_ENVIRONMENT_KEYS
    .map((key) => env[key])
    .filter((value): value is string => Boolean(value));

  for (const rawUrl of [...rawUrls, ...proxyUrls]) {
    const display = redactUrl(rawUrl, proxyUrls.includes(rawUrl));
    configuredUrls.set(rawUrl, display);
    if (display === REDACTED_DIAGNOSTIC) addUriForms(replacements, rawUrl);
    try {
      const url = new URL(rawUrl);
      const username = safeDecode(url.username);
      const password = safeDecode(url.password);
      if (password.length === 0) {
        addUriForms(replacements, url.username);
        addUriForms(replacements, username);
      }
      addUriForms(replacements, url.password);
      addBasicForms(replacements, url.username, url.password);
      addUriForms(replacements, password);
      addBasicForms(replacements, username, password);
    } catch {
      // The complete malformed value is still replaced via configuredUrls.
    }
  }

  const username = env.AUTH_USERNAME ?? "";
  const password = env.AUTH_PASSWORD ?? "";
  if (password.length === 0) addUriForms(replacements, username);
  addUriForms(replacements, password);
  if (username !== "" || password !== "") {
    addBasicForms(replacements, username, password);
  }

  return {
    normalizedSecrets: [...new Set([...replacements].flatMap(value => [...secretTextForms(value)]))].filter(Boolean),
    replacements: [...replacements]
      .filter((value) => value !== REDACTED && value !== REDACTED_DIAGNOSTIC)
      .sort((left, right) => right.length - left.length),
    // A shorter malformed setting must not consume the prefix of a longer
    // credential-bearing value before that complete value can be removed.
    configuredUrls: new Map(
      [...configuredUrls].sort(([left], [right]) => right.length - left.length),
    ),
  };
}

export function initializeDiagnosticSanitizer(
  env: NodeJS.ProcessEnv = process.env,
): void {
  snapshot ??= captureSnapshot(env);
}

function getSnapshot(): CredentialSnapshot {
  initializeDiagnosticSanitizer();
  return snapshot!;
}

export function resetDiagnosticSanitizerForTests(): void {
  snapshot = undefined;
}

function sanitizeText(value: string): string {
  if (value.length > MAX_STRING_LENGTH) {
    return REDACTED_DIAGNOSTIC;
  }

  const credentials = getSnapshot();
  let sanitized = value;
  for (const [configuredUrl, redactedUrl] of credentials.configuredUrls) {
    sanitized = sanitized.split(configuredUrl).join(redactedUrl);
  }

  // Remove any URL userinfo before applying literal matching. Greedy matching
  // through the last @ also handles malformed multi-@ authority text.
  sanitized = sanitized.replace(
    /\b([a-z][a-z0-9+.-]*:\/\/)[^/\s?#]*@/giu,
    "$1",
  );

  for (const secret of credentials.replacements) {
    sanitized = sanitized.split(secret).join(REDACTED);
  }
  // Escaped or mixed-case percent representations may not match literally.
  // Withhold the diagnostic rather than attempting unsafe serialized surgery.
  if (containsConfiguredCredential(sanitized)) return REDACTED_DIAGNOSTIC;
  return sanitized;
}

/** No diagnostic size/depth limits: callers already enforce content limits. */
export function containsConfiguredCredential(value: string): boolean {
  const secrets = getSnapshot().normalizedSecrets;
  if (secrets.length === 0) return false;
  for (const form of secretTextForms(value)) {
    if (secrets.some((secret) => form.includes(secret))) return true;
  }
  return false;
}

export function sanitizeDiagnosticText(value: string): string {
  try {
    return sanitizeText(value);
  } catch {
    return REDACTED_DIAGNOSTIC;
  }
}

function isSecretKey(key: PropertyKey): boolean {
  return typeof key === "string"
    && /(?:authorization|password|passwd|credential|username|user_name|userinfo)/iu
      .test(key);
}

function sanitizeValueInternal(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (typeof value === "string") return sanitizeText(value);
  if (
    value === null
    || typeof value === "number"
    || typeof value === "boolean"
    || typeof value === "undefined"
    || typeof value === "bigint"
  ) {
    return value;
  }
  if (typeof value === "symbol" || typeof value === "function") {
    return UNAVAILABLE;
  }
  if (depth >= MAX_DEPTH) return REDACTED_DIAGNOSTIC;

  const objectValue = value as object;
  if (seen.has(objectValue)) return REDACTED_DIAGNOSTIC;
  seen.add(objectValue);

  if (Array.isArray(value)) {
    const result = value
      .slice(0, MAX_COLLECTION_ITEMS)
      .map((item) => sanitizeValueInternal(item, depth + 1, seen));
    if (value.length > MAX_COLLECTION_ITEMS) result.push(REDACTED_DIAGNOSTIC);
    return result;
  }

  const result: Record<PropertyKey, unknown> = {};
  if (value instanceof Error) {
    result.name = sanitizeText(value.name);
    result.message = sanitizeText(value.message);
    if (value.stack !== undefined) result.stack = sanitizeText(value.stack);
    if (value.cause !== undefined) {
      result.cause = sanitizeValueInternal(value.cause, depth + 1, seen);
    }
  }

  let keys: PropertyKey[];
  try {
    keys = Reflect.ownKeys(objectValue);
  } catch {
    return REDACTED_DIAGNOSTIC;
  }

  for (const key of keys.slice(0, MAX_COLLECTION_ITEMS)) {
    // Dropping secret-bearing keys avoids renamed-key collisions and keeps
    // user-controlled __proto__ assignments out of diagnostic copies.
    if (typeof key !== "string" || containsConfiguredCredential(key) || key === "__proto__") continue;
    if (
      value instanceof Error
      && ["name", "message", "stack", "cause"].includes(String(key))
    ) {
      continue;
    }
    let item: unknown;
    try {
      item = Reflect.get(objectValue, key);
    } catch {
      result[key] = UNAVAILABLE;
      continue;
    }
    result[key] = isSecretKey(key)
      ? REDACTED
      : sanitizeValueInternal(item, depth + 1, seen);
  }
  if (keys.length > MAX_COLLECTION_ITEMS) {
    result.__truncated__ = REDACTED_DIAGNOSTIC;
  }
  return result;
}

export function sanitizeDiagnosticValue(value: unknown): unknown {
  try {
    return sanitizeValueInternal(value, 0, new WeakSet<object>());
  } catch {
    return REDACTED_DIAGNOSTIC;
  }
}

export function sanitizeErrorForTransport(value: unknown): Error {
  try {
    const source = value instanceof Error ? value : new Error(String(value));
    const safeError = new Error(sanitizeText(source.message));
    safeError.name = sanitizeText(source.name);
    if (source.stack !== undefined) {
      safeError.stack = sanitizeText(source.stack);
    }
    if (source.cause !== undefined) {
      safeError.cause = sanitizeValueInternal(
        source.cause,
        1,
        new WeakSet<object>([source]),
      );
    }
    return safeError;
  } catch {
    return new Error(REDACTED_DIAGNOSTIC);
  }
}
