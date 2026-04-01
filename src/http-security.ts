export interface HttpSecurityConfig {
  harden: boolean;
  requireAuth: boolean;
  authToken?: string;
  restrictOrigins: boolean;
  allowedOrigins: string[];
  enableDnsRebindingProtection: boolean;
  allowedHosts: string[];
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
