/**
 * Build HTTP headers carrying SearXNG Basic auth credentials from the
 * environment (`AUTH_USERNAME` / `AUTH_PASSWORD`).
 *
 * Returns an object with a single `Authorization: Basic ...` header when both
 * env vars are set, or an empty object otherwise — callers can spread it into
 * their existing `headers` object without conditionals.
 *
 * Shared by `/search`, `/config` (capability discovery) and `/autocompleter`
 * (suggestions) so auth-gated SearXNG instances don't 401 on the non-search
 * endpoints. `web_url_read` deliberately does NOT use this — it fetches
 * arbitrary URLs.
 */
export function buildSearxngAuthHeaders(): Record<string, string> {
  const username = process.env.AUTH_USERNAME;
  const password = process.env.AUTH_PASSWORD;

  if (username && password) {
    const base64Auth = Buffer.from(`${username}:${password}`).toString("base64");
    return { Authorization: `Basic ${base64Auth}` };
  }

  return {};
}
