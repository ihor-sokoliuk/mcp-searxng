export const BROWSER_SOLVER_DUPLICATE_ENDPOINT_ERROR =
  "FLARESOLVERR_URL and BYPARR_URL must identify different services.";

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

export function resolveBrowserSolverEndpoints(): BrowserSolverEndpointSelection[] {
  const flareSolverrUrl = configuredValue("FLARESOLVERR_URL");
  const byparrUrl = configuredValue("BYPARR_URL");
  const selections: BrowserSolverEndpointSelection[] = [];
  if (flareSolverrUrl) {
    selections.push({
      provider: "flaresolverr",
      endpoint: normalizeEndpoint("FLARESOLVERR_URL", flareSolverrUrl),
    });
  }
  if (byparrUrl) {
    selections.push({
      provider: "byparr",
      endpoint: normalizeEndpoint("BYPARR_URL", byparrUrl),
    });
  }
  if (
    selections.length === 2
    && selections[0].endpoint.href === selections[1].endpoint.href
  ) {
    throw new BrowserSolverConfigurationIssue(BROWSER_SOLVER_DUPLICATE_ENDPOINT_ERROR);
  }
  return selections;
}

export function validateBrowserSolverEnvironment(): string | null {
  try {
    resolveBrowserSolverEndpoints();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "Invalid browser solver configuration.";
  }
}
