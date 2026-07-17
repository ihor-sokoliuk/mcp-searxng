import { createHash, timingSafeEqual } from "node:crypto";

export interface HttpSecurityConfig {
  harden: boolean;
  requireAuth: boolean;
  authToken?: string;
  restrictOrigins: boolean;
  allowedOrigins: string[];
  enableDnsRebindingProtection: boolean;
  allowedHosts: string[];
  trustProxy: boolean | number | string;
  exposeFullConfig: boolean;
  allowPrivateUrls: boolean;
}

function isEnabled(value: string | undefined): boolean {
  return value === "true";
}

function parseCsv(value: string | undefined): string[] {
  return (value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseTrustProxy(value: string | undefined): boolean | number | string {
  const trimmed = value?.trim();
  // Treat "0" as disabled (false): operators use 0 to turn numeric knobs off,
  // and Express would otherwise mis-parse the string "0" as a bogus trust subnet.
  if (!trimmed || trimmed === "false" || trimmed === "0") {
    return false;
  }
  if (trimmed === "true") {
    return true;
  }
  if (/^[1-9]\d*$/.test(trimmed)) {
    return Number(trimmed);
  }
  return trimmed;
}

// Default DNS-rebinding allowlist when MCP_HTTP_ALLOWED_HOSTS is unset. The SDK
// transport matches the raw Host header (port included) with exact Array.includes,
// so the bind port must be baked into the loopback defaults or hardened mode 403s
// every request on any non-80 port (BUG-012). The bare hostnames are always kept
// too: they match a portless Host — a client or reverse proxy that omits the port
// (as on default ports 80/443). [::1] mirrors the SDK's own localhost default.
function defaultAllowedHosts(port?: number): string[] {
  const hosts = ["127.0.0.1", "localhost", "[::1]"];
  if (port !== undefined) {
    hosts.push(`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`);
  }
  return hosts;
}

export function getHttpSecurityConfig(port?: number): HttpSecurityConfig {
  const harden = isEnabled(process.env.MCP_HTTP_HARDEN);
  const authToken = process.env.MCP_HTTP_AUTH_TOKEN;
  const allowedOrigins = parseCsv(process.env.MCP_HTTP_ALLOWED_ORIGINS);
  const allowedHosts = parseCsv(process.env.MCP_HTTP_ALLOWED_HOSTS);

  return {
    harden,
    requireAuth: harden,
    authToken,
    restrictOrigins: harden,
    allowedOrigins,
    enableDnsRebindingProtection: harden,
    allowedHosts: allowedHosts.length > 0 ? allowedHosts : defaultAllowedHosts(port),
    trustProxy: parseTrustProxy(process.env.MCP_HTTP_TRUST_PROXY),
    exposeFullConfig: isEnabled(process.env.MCP_HTTP_EXPOSE_FULL_CONFIG),
    allowPrivateUrls: isEnabled(process.env.MCP_HTTP_ALLOW_PRIVATE_URLS),
  };
}

export function validateHttpSecurityConfig(config: HttpSecurityConfig): void {
  if (!config.harden) {
    return;
  }

  if (!config.authToken) {
    throw new Error("MCP_HTTP_HARDEN=true requires MCP_HTTP_AUTH_TOKEN to be set.");
  }

  if (config.allowedOrigins.length === 0) {
    throw new Error("MCP_HTTP_HARDEN=true requires MCP_HTTP_ALLOWED_ORIGINS to be set.");
  }
}

export function isRequestAuthorized(headerValue: string | undefined, config: HttpSecurityConfig): boolean {
  if (!config.requireAuth) {
    return true;
  }

  if (typeof headerValue !== "string" || !config.authToken) {
    return false;
  }

  const providedDigest = createHash("sha256").update(headerValue).digest();
  const expectedDigest = createHash("sha256").update(`Bearer ${config.authToken}`).digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}

export function isOriginAllowed(origin: string | undefined, config: HttpSecurityConfig): boolean {
  if (!config.restrictOrigins) {
    return true;
  }

  if (!origin) {
    return true;
  }

  return config.allowedOrigins.includes(origin);
}
