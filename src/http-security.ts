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

export function getHttpSecurityConfig(): HttpSecurityConfig {
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
    allowedHosts: allowedHosts.length > 0 ? allowedHosts : ["127.0.0.1", "localhost"],
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

  return headerValue === `Bearer ${config.authToken}` || headerValue === config.authToken;
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
