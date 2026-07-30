export const BROWSER_SOLVER_MUTUAL_EXCLUSION_ERROR =
  "Configure only one browser solver: FLARESOLVERR_URL or BYPARR_URL, not both.";

export class BrowserSolverConfigurationIssue extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserSolverConfigurationIssue";
  }
}

export type BrowserSolverProvider = "flaresolverr" | "byparr";

export interface BrowserSolverEndpointSelection {
  provider: BrowserSolverProvider;
  endpoint: URL;
}

function configuredValue(name: "FLARESOLVERR_URL" | "BYPARR_URL"): string | null {
  const value = process.env[name];
  return value === undefined || value.trim() === "" ? null : value.trim();
}

function hasForbiddenEndpointComponents(endpoint: URL): boolean {
  return [
    endpoint.username,
    endpoint.password,
    endpoint.search,
    endpoint.hash,
  ].some((component) => component !== "");
}

function normalizeEndpoint(name: "FLARESOLVERR_URL" | "BYPARR_URL", value: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new BrowserSolverConfigurationIssue(
      `${name} must be an absolute HTTP or HTTPS service base URL.`,
    );
  }

  if (
    !["http:", "https:"].includes(endpoint.protocol)
    || endpoint.hostname === ""
    || hasForbiddenEndpointComponents(endpoint)
  ) {
    throw new BrowserSolverConfigurationIssue(
      `${name} must be an absolute HTTP or HTTPS service base URL without userinfo, a query, or a fragment.`,
    );
  }

  const pathWithoutTrailingSlash = endpoint.pathname.replace(/\/+$/u, "");
  endpoint.pathname = pathWithoutTrailingSlash.endsWith("/v1")
    ? pathWithoutTrailingSlash
    : `${pathWithoutTrailingSlash}/v1`;
  return endpoint;
}

export function resolveBrowserSolverEndpoint(): BrowserSolverEndpointSelection | null {
  const flareSolverrUrl = configuredValue("FLARESOLVERR_URL");
  const byparrUrl = configuredValue("BYPARR_URL");

  if (flareSolverrUrl && byparrUrl) {
    throw new BrowserSolverConfigurationIssue(BROWSER_SOLVER_MUTUAL_EXCLUSION_ERROR);
  }
  if (flareSolverrUrl) {
    return {
      provider: "flaresolverr",
      endpoint: normalizeEndpoint("FLARESOLVERR_URL", flareSolverrUrl),
    };
  }
  if (byparrUrl) {
    return {
      provider: "byparr",
      endpoint: normalizeEndpoint("BYPARR_URL", byparrUrl),
    };
  }
  return null;
}

export function validateBrowserSolverEnvironment(): string | null {
  try {
    resolveBrowserSolverEndpoint();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "Invalid browser solver configuration.";
  }
}
