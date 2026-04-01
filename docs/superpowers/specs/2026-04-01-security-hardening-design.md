# Security Hardening Design

## Goal

Address the reported Undici CVE concerns and the HTTP transport security risks without breaking existing customer deployments that automatically upgrade to new releases.

## Context

The project currently has two categories of security work:

1. Dependency hygiene:
   - `package.json` declares `undici` as `^7.0.0`, which can trigger scanners to report vulnerable ranges even when the lockfile is already resolved to a patched release.

2. Runtime and exposure risks:
   - Optional HTTP transport is reachable on the network.
   - CORS is permissive.
   - DNS rebinding protection is not enabled.
   - `web_url_read` can fetch arbitrary URLs.
   - The config resource exposes operational details that are useful for debugging but also useful for reconnaissance.

The user requirement is explicit: future releases must preserve current setup and behavior by default so customers do not break immediately on automatic update. Hardening must be available as an option.

## Non-Goals

- Changing the default HTTP bind behavior away from `0.0.0.0`.
- Requiring existing customers to add new environment variables to keep current deployments working.
- Removing HTTP transport support.
- Designing bespoke mitigations only for Undici WebSocket code paths not used by this project.

## Design Summary

Ship this as a backward-compatible security release with two layers:

1. Always-on dependency fix:
   - Raise the declared minimum safe `undici` version in `package.json`.
   - Refresh the lockfile.
   - Re-run dependency verification so the manifest and installed tree both reflect a patched baseline.

2. Opt-in HTTP hardening mode:
   - Preserve current behavior by default.
   - Add a hardened profile that operators can enable explicitly with environment variables.
   - In hardened mode, tighten request authentication, origin policy, rebinding protection, SSRF posture, and configuration exposure.

## Requirements

### 1. Dependency Hardening

- Update `package.json` so the declared `undici` range starts at a patched version rather than `^7.0.0`.
- Update `package-lock.json` accordingly.
- Keep the change backward-compatible with current Node support.
- Re-run the project security checks after the dependency update.

### 2. Backward-Compatible Defaults

When hardening mode is not enabled:

- HTTP transport must continue to work with the current environment model.
- Binding behavior must remain unchanged.
- No new required auth token or origin configuration should be introduced.
- Existing customers should not need to update their deployment config for the new release to keep working.

### 3. Opt-In Hardened HTTP Mode

Add an explicit hardening configuration layer for HTTP transport.

The design should support either a single top-level switch with related optional overrides, or a small set of focused flags, but the user-facing model should be simple and well documented.

When hardened mode is enabled:

- HTTP requests must require an authentication token.
- DNS rebinding protection must be enabled.
- CORS must no longer default to `origin: '*'`; it must use an explicit allowlist or equivalent restricted configuration.
- The config resource must reduce or redact sensitive operational details.
- `web_url_read` must apply SSRF protections by default.

### 4. SSRF Protection Model

In hardened mode, `web_url_read` should reject clearly sensitive destinations unless explicitly allowed:

- localhost hostnames
- loopback addresses
- private IPv4 ranges
- link-local addresses
- other obviously internal-only network targets identified during implementation

The override model must be explicit so operators understand when they are allowing internal fetches again.

This protection is scoped to hardened mode to preserve backward compatibility for existing deployments.

### 5. Resource Exposure Reduction

The `config://server-config` resource should become less revealing in hardened mode.

Examples of acceptable behavior:

- show `configured: true/false` instead of the full upstream URL
- keep booleans such as auth/proxy presence
- omit exact network details unless a deliberate debug-oriented override is enabled

Default mode should remain compatible with the current behavior unless a narrower change is judged safe and non-breaking during implementation.

### 6. Documentation

Update user-facing documentation to describe:

- the dependency floor update
- the existence of hardened HTTP mode
- the environment variables that enable and control it
- the fact that default behavior remains compatible for existing deployments
- recommended production guidance for customers who expose HTTP transport on a network

Documentation should make the secure path obvious without implying that the release changed default behavior.

## Proposed Configuration Shape

Final variable names can be refined during implementation, but the design intent is:

- one primary flag to enable hardened HTTP behavior
- one required token variable for hardened mode authentication
- one origin allowlist variable for hardened CORS
- optional variables for rebinding allowlist behavior
- optional variable to permit internal URL reads in hardened mode
- optional variable to expose fuller config-resource detail for debugging

The naming should be specific to HTTP mode so operators can understand the blast radius of each variable.

## Architecture Changes

### HTTP Server

Add a small configuration layer in the HTTP server module that:

- reads hardening-related environment variables
- determines whether hardened mode is active
- applies auth checks before MCP request handling
- configures CORS differently in default vs hardened mode
- enables DNS rebinding protection when hardened mode is active

This should be implemented as focused helper functions rather than spreading conditionals across handlers.

### URL Reader

Add a URL policy check before performing the fetch when hardened mode is active.

The URL policy should:

- parse and validate the target
- identify blocked hosts or IP ranges
- produce clear user-facing errors when a URL is blocked by security policy

Keep the fetch and conversion flow otherwise unchanged.

### Resources

Adjust config resource generation so it can return either:

- the current detailed view, or
- a reduced view for hardened mode

This logic should live in the resource generation layer, not in the request handler.

## Error Handling

Add clear error messages for:

- missing or invalid hardened-mode auth token
- blocked origin in hardened mode
- blocked internal URL read in hardened mode
- missing hardened-mode configuration required by the chosen profile

Errors should explain what was denied and which configuration knob the operator can use if the denial was intentional.

## Testing Strategy

Add or extend tests for:

- dependency update verification as part of the standard audit workflow
- default mode HTTP behavior remaining compatible
- hardened mode rejecting missing or invalid auth
- hardened mode applying restricted CORS behavior
- hardened mode enabling rebinding protection behavior
- hardened mode blocking internal URL reads
- hardened mode config resource redaction
- override paths that intentionally re-enable internal URL reads or fuller config detail

Tests should prove both compatibility and hardening behavior so future changes do not silently weaken either side.

## Rollout Strategy

Release as a normal backward-compatible version with release notes that say:

- defaults are unchanged for compatibility
- Undici minimum safe version has been raised
- customers who expose HTTP transport should enable hardened mode

This gives customers a no-break upgrade path while making the security improvements available immediately.

## Risks and Trade-Offs

- Keeping default behavior unchanged means the highest-impact runtime protections are not automatic.
- Putting SSRF protection behind hardened mode preserves compatibility but leaves default HTTP deployments weaker.
- Requiring a hardened profile for stronger protection is a deliberate compromise to satisfy automatic-update stability.

This trade-off is acceptable because it matches the stated release requirement.

## Success Criteria

- The package no longer advertises a vulnerable `undici` version range.
- Existing deployments continue working after upgrade without new required config.
- Operators can enable hardened HTTP mode with documented environment variables.
- Hardened mode materially reduces HTTP exposure risk through auth, CORS restriction, rebinding protection, SSRF controls, and reduced config disclosure.
- Tests and docs cover both the compatibility path and the hardened path.
