# MCP Registry publication

Release tags trigger **Publish NPM Package**. Once that workflow succeeds,
**Publish MCP Registry** starts independently for the same tag and commit.
It executes trusted publication tooling from the workflow's default-branch
revision. Only release metadata is read from the originating npm commit; code
from that commit is never checked out or executed by the privileged workflow.
The registry workflow must be present on the default branch before the release.
It does not build or republish the npm package.
Completed reruns of older releases that still contain the registry job inside
their npm workflow are detected and skipped by the new workflow.

The registry workflow checks immediately for an existing matching, active entry
and for the exact npm version. There is no fixed startup delay. Temporary npm
visibility and registry errors are retried after 10, 20, 40, then 60 seconds,
with subsequent waits capped at 60 seconds. Readiness, publishing, and final
verification share a **15-minute maximum recovery window**. A successful run
finishes immediately after verification; the 20-minute Actions job timeout
also allows time for checkout and publisher installation.

The npm-version-not-found validation response is retryable even though MCP
Registry reports it as HTTP 400. Other validation errors and authentication
failures stop promptly. Temporary HTTP 408/429/5xx responses and recognized
network failures during publication are retried. Intermediate failures remain
ordinary waiting messages, so a recovered run finishes successfully. Exhausting
the recovery window fails the registry workflow and preserves failure alerts.

Before every publish attempt, the workflow checks whether the expected version
already exists. A successful command or a conflict is followed by polling for a
matching active entry; neither alone establishes success. This also reconciles
ambiguous publisher timeouts and makes reruns safe. A mismatched existing entry
fails without overwriting it.

## Recovery

Inspect **Publish MCP Registry** for the affected release. If npm publication
succeeded but registry publication failed, rerun only that registry workflow's
failed job. Do not rerun npm publication or recreate the release tag. The rerun
uses the original npm run's metadata and checks that its version tag still points
to that commit. A later package version on `main` is not substituted for the release.

## Offline verification

Run `node --test scripts/publish-mcp-registry.test.mjs`. These tests use injected
HTTP and publisher responses and a simulated clock; they never publish packages,
request OIDC credentials, or wait for real propagation. CI runs them on the
supported Node versions. Live publication is verified on the next authorized
release.
