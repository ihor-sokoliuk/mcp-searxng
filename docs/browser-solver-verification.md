# Browser solver verification

Verification date: 2026-07-30

| Provider | Version | Pinned multi-architecture manifest | Tested architecture | Timeout wire unit | Result |
|---|---:|---|---|---|---|
| FlareSolverr | 3.5.0 | `ghcr.io/flaresolverr/flaresolverr:v3.5.0@sha256:139dfee1c6f89249c8d665d1333a42e8ec74ec0a86bc6bb1c8461e10d3a66a47` | `linux/amd64` (`sha256:258523d25e4e07028c3a206f0e03ae807b26a50a201dd320f09a18464ecf86fa`) | milliseconds | verified |
| Byparr | 2.1.0 | `ghcr.io/thephaseless/byparr:2.1.0@sha256:01a46a2865d9a6db5eb8ead04ec0dd33b8fbe233e8565ae70b50d4cc0af4cfb0` | `linux/amd64` (`sha256:5e41fe2278f187bfafc762fee822c0678deb49e229171c89a116e56820ca7278`) | whole seconds | verified |

These results are verification by this project, not an upstream compatibility
claim. Both providers were exercised through the same `/v1` request/response
adapter and authoritative target replay. FlareSolverr returns a cookie-only
response when requested. Byparr 2.1.0 ignores `returnOnlyCookies`, so the client
accepts a bounded 5 MiB envelope and discards rendered content after parsing.

The real-container gate requires a directly observed anti-bot response no more
than 30 minutes before each solved request. Record the UTC timestamp, public
target, direct HTTP status or bounded anti-bot marker name, elapsed time,
container digest, and final content assertion. Never record cookies,
credentials, endpoint userinfo, or response bodies containing secrets.

The E2E runner enforces the two-provider matrix in one invocation when
`BROWSER_SOLVER_REAL_MATRIX=true`, `VERIFY_FLARESOLVERR_URL`, and
`VERIFY_BYPARR_URL` are set. Missing either verification endpoint makes the
matrix test fail; the runner starts two separate MCP child processes so the
production mutual-exclusion rule remains intact.

Preferred deployment keeps the selected solver on the same private container
network as `mcp-searxng` with no published host port. A loopback-only port may
be used temporarily for diagnostics. Never expose a solver API publicly.

HTTP-client cancellation is propagated immediately, but the remote browser
process may continue until the provider's configured internal timeout after a
client disconnect. The provider timeout therefore remains the remote hard
bound.

## 2026-07-30 real-container result

At `2026-07-30T20:42:41Z`, a direct `HEAD` request to
`https://eprint.iacr.org/2025/858.pdf` returned HTTP 403 with the bounded
`Cf-Mitigated: challenge` marker. Within the following five minutes, the built
MCP server completed the same protected-PDF assertion through each pinned
container without a provider skip:

| Provider | Local endpoint exposure | Suite elapsed | Assertion |
|---|---|---:|---|
| FlareSolverr 3.5.0 | loopback-only diagnostic port | 15.2 s | extracted `Encrypted Matrix-Vector Products` and `Abstract` |
| Byparr 2.1.0 | loopback-only diagnostic port | 23.9 s | extracted `Encrypted Matrix-Vector Products` and `Abstract` |

The disposable diagnostic containers were removed after verification. No
cookie, solver response body, credential, or endpoint userinfo was retained.
