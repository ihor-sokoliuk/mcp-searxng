import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { McpServer } from "@modelcontextprotocol/server";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";
import { createHttpServer } from "../../src/http-server.js";
import { createMcpServer, ToolAdmissionController } from "../../src/index.js";
import { FetchMocker, createCapturingMockFetch } from "../helpers/mock-fetch.js";
import { createJwtVerifier, createOAuthProtection, getHttpOAuthConfig } from "../../src/oauth-http.js";
import { createTestResults, printTestSummary, testFunction } from "../helpers/test-utils.js";
import { snapshotProcessEnv, restoreProcessEnv } from "../helpers/env-utils.js";

export async function runTests() {
  const results = createTestResults();
  const snapshot = snapshotProcessEnv();
  const pair = await generateKeyPair("ES256");
  const otherPair = await generateKeyPair("ES256");
  const jwk = { ...await exportJWK(pair.publicKey), kid: "test-key" };
  function configure() {
    for (const key of Object.keys(process.env)) if (key.startsWith("MCP_HTTP_")) delete process.env[key];
    Object.assign(process.env, {
      MCP_HTTP_AUTH_MODE: "oauth",
      MCP_HTTP_OAUTH_ISSUER: "https://issuer.example.com",
      MCP_HTTP_OAUTH_JWKS_URL: "https://issuer.example.com/jwks",
      MCP_HTTP_OAUTH_RESOURCE: "https://mcp.example.com/mcp",
      MCP_HTTP_OAUTH_SCOPES: "mcp:tools mcp:resources",
    });
  }
  async function token(changes: JWTPayload = {}, key = pair.privateKey, typ = "at+jwt") {
    return new SignJWT({
      iss: "https://issuer.example.com", aud: "https://mcp.example.com/mcp",
      sub: "test-user", client_id: "test-client", jti: "test-token-id", scope: "mcp:tools mcp:resources",
      iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300, ...changes,
    }).setProtectedHeader({ alg: "ES256", typ, kid: "test-key" }).sign(key);
  }
  try {
    configure();
    const config = getHttpOAuthConfig()!;
    const verifier = createJwtVerifier(config, createLocalJWKSet({ keys: [jwk] }));
    const protection = createOAuthProtection(config, verifier);
    await testFunction("OAuth config is optional and rejects incomplete, mixed and unsafe settings", () => {
      configure();
      delete process.env.MCP_HTTP_OAUTH_ISSUER;
      assert.throws(getHttpOAuthConfig, /MCP_HTTP_OAUTH_ISSUER/);
      configure();
      process.env.MCP_HTTP_AUTH_TOKEN = "static-test-value";
      assert.throws(getHttpOAuthConfig, /cannot be combined/);
      configure();
      process.env.MCP_HTTP_AUTH_MODE = "static";
      assert.throws(getHttpOAuthConfig, /require MCP_HTTP_AUTH_MODE/);
      configure();
      process.env.MCP_HTTP_AUTH_MODE = "invalid";
      assert.throws(getHttpOAuthConfig, /must be static or oauth/);
      for (const value of ["http://issuer.example.com", "https://user:password@issuer.example.com", "https://issuer.example.com?q=secret", "https://issuer.example.com/#secret"]) {
        configure();
        process.env.MCP_HTTP_OAUTH_ISSUER = value;
        assert.throws(getHttpOAuthConfig, error => error instanceof Error && !error.message.includes(value));
      }
      for (const scopes of ["", 'bad"scope', "bad\\scope"]) {
        configure();
        process.env.MCP_HTTP_OAUTH_SCOPES = scopes;
        assert.throws(getHttpOAuthConfig, /scope names/);
      }
      configure();
      for (const key of Object.keys(process.env)) if (key.startsWith("MCP_HTTP_")) delete process.env[key];
      assert.equal(getHttpOAuthConfig(), undefined);
      configure();
    }, results);

    const invalidCases: Array<[string, () => Promise<string>]> = [
      ["signature", () => token({}, otherPair.privateKey)],
      ["issuer", () => token({ iss: "https://other.example.com" })],
      ["audience", () => token({ aud: "https://another-resource.example.com" })],
      ["expiry", () => token({ exp: 1 })],
      ["missing expiry", () => token({ exp: undefined })],
      ["future activation", () => token({ nbf: Math.floor(Date.now() / 1000) + 300 })],
      ["ID token type", () => token({}, pair.privateKey, "JWT")],
      ["client identity", () => token({ client_id: 123 })],
      ["missing subject", () => token({ sub: undefined })],
      ["missing token identity", () => token({ jti: undefined })],
      ["malformed scopes", () => token({ scope: ["mcp:tools"] })],
      ["opaque token", async () => "not-a-jwt-secret"],
      ["unsigned token", async () => `${Buffer.from(JSON.stringify({ alg: "none", typ: "at+jwt" })).toString("base64url")}.${(await token()).split(".")[1]}.`],
      ["symmetric algorithm confusion", async () => new SignJWT({}).setProtectedHeader({ alg: "HS256", typ: "at+jwt" }).sign(new TextEncoder().encode(JSON.stringify(jwk)))],
    ];
    for (const [name, makeToken] of invalidCases) {
      await testFunction(`OAuth rejects invalid ${name} with a safe discovery challenge`, async () => {
        const value = await makeToken();
        const failure = await protection.authorize(`Bearer ${value}`);
        assert.ok(failure instanceof Response);
        assert.equal(failure?.status, 401);
        assert.match(failure!.headers.get("www-authenticate")!, /resource_metadata="https:\/\/mcp.example.com\/\.well-known\/oauth-protected-resource\/mcp"/);
        assert.ok(!(await failure!.text()).includes(value));
      }, results);
    }
    await testFunction("OAuth requires every configured scope and accepts a correctly signed access token", async () => {
      const identity = await protection.authorize(`Bearer ${await token()}`);
      assert.equal(typeof identity, "string");
      assert.equal(await protection.authorize(`Bearer ${await token({ aud: [config.resource, "https://other.example.com"] })}`), identity);
      const failure = await protection.authorize(`Bearer ${await token({ scope: "mcp:tools" })}`);
      assert.ok(failure instanceof Response);
      assert.equal(failure?.status, 403);
      assert.match(failure!.headers.get("www-authenticate")!, /insufficient_scope/);
      assert.match(failure!.headers.get("www-authenticate")!, /mcp:tools mcp:resources/);
    }, results);
    await testFunction("OAuth hides signing-key fetch failures", async () => {
      const failingVerifier = createJwtVerifier(config, async () => { throw new Error("private-provider-detail"); });
      const failure = await createOAuthProtection(config, failingVerifier).authorize(`Bearer ${await token()}`);
      assert.ok(failure instanceof Response);
      assert.equal(failure?.status, 401);
      assert.ok(!(await failure!.text()).includes("private-provider-detail"));
    }, results);
    await testFunction("OAuth production resolver uses the configured JWKS endpoint", async () => {
      const originalFetch = globalThis.fetch;
      const destinations: string[] = [];
      globalThis.fetch = async input => {
        destinations.push(String(input));
        return new Response(JSON.stringify({ keys: [jwk] }), { status: 200, headers: { "content-type": "application/json" } });
      };
      try {
        const realProtection = createOAuthProtection(config);
        assert.equal(typeof await realProtection.authorize(`Bearer ${await token()}`), "string");
        assert.deepEqual(destinations, [config.jwksUrl]);
      } finally {
        globalThis.fetch = originalFetch;
      }
    }, results);
    await testFunction("OAuth metadata honors hardened Host validation without authentication", async () => {
      process.env.MCP_HTTP_HARDEN = "true";
      process.env.MCP_HTTP_ALLOWED_HOSTS = "mcp.example.com";
      process.env.MCP_HTTP_ALLOWED_ORIGINS = "https://client.example.com";
      const hardened = await createHttpServer(() => new McpServer({ name: "host-test", version: "1" }), undefined, verifier);
      assert.equal((await request(hardened).get(protection.metadataPath).set("Host", "attacker.example.com")).status, 403);
      assert.equal((await request(hardened).get(protection.metadataPath).set("Host", "mcp.example.com")).status, 200);
    }, results);

    let dispatches = 0;
    const app = await createHttpServer(() => {
      dispatches++;
      return new McpServer({ name: "oauth-test", version: "1.0.0" }, { capabilities: { tools: {}, resources: {} } });
    }, undefined, verifier);
    await testFunction("OAuth metadata is public and authorization is checked on POST, GET and DELETE", async () => {
      const metadata = await request(app).get("/.well-known/oauth-protected-resource/mcp");
      assert.equal(metadata.status, 200);
      assert.deepEqual(metadata.body, protection.metadata);
      const before = dispatches;
      for (const method of ["post", "get", "delete"] as const) {
        const unauthenticated = await request(app)[method]("/mcp?access_token=ignored-secret").set("Origin", "http://localhost");
        assert.equal(unauthenticated.status, 401);
        assert.match(unauthenticated.headers["access-control-expose-headers"], /WWW-Authenticate/);
        assert.ok(unauthenticated.headers["www-authenticate"]);
        assert.ok(!unauthenticated.text.includes("ignored-secret"));
        const denied = await request(app)[method]("/mcp").auth(await token({ scope: "mcp:tools" }), { type: "bearer" });
        assert.equal(denied.status, 403);
      }
      assert.equal(dispatches, before);
    }, results);
    await testFunction("OAuth authorizes modern discovery and legacy sessions, rechecking each session request", async () => {
      const accessToken = await token();
      const modern = await request(app).post("/mcp").auth(accessToken, { type: "bearer" })
        .set("Accept", "application/json, text/event-stream").set("MCP-Protocol-Version", "2026-07-28").set("MCP-Method", "server/discover")
        .send({ jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} } } });
      assert.equal(modern.status, 200, modern.text);
      assert.ok(modern.body.result);
      assert.ok(!modern.text.includes(accessToken));
      const legacy = await request(app).post("/mcp").auth(accessToken, { type: "bearer" })
        .set("Accept", "application/json, text/event-stream")
        .send({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
      assert.equal(legacy.status, 200, legacy.text);
      const session = legacy.headers["mcp-session-id"];
      assert.ok(session);
      for (const identity of [{ sub: "different-user" }, { client_id: "different-client" }]) {
        for (const method of ["post", "get", "delete"] as const) {
          const denied = await request(app)[method]("/mcp").set("mcp-session-id", session).auth(await token(identity), { type: "bearer" })
            .set("Accept", "application/json, text/event-stream")
            .send(method === "post" ? { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} } : undefined);
          assert.equal(denied.status, 403, denied.text);
        }
      }
      for (const method of ["get", "delete"] as const) {
        const denied = await request(app)[method]("/mcp").set("mcp-session-id", session);
        assert.equal(denied.status, 401);
      }
      const removed = await request(app).delete("/mcp").set("mcp-session-id", session).auth(await token({ jti: "refreshed-token" }), { type: "bearer" });
      assert.ok(removed.status >= 200 && removed.status < 300);
    }, results);
    await testFunction("OAuth tokens stay out of upstream requests, resources, tool output and diagnostics", async () => {
      process.env.SEARXNG_URL = "https://test-searx.example.com";
      const capture = createCapturingMockFetch();
      const mocker = new FetchMocker();
      const diagnostics: string[] = [];
      const originalWarn = console.warn;
      const originalError = console.error;
      mocker.mock(capture.mockFetch);
      console.warn = console.error = (...args: unknown[]) => { diagnostics.push(args.map(String).join(" ")); };
      try {
        const resourceApp = await createHttpServer(modern => createMcpServer(new ToolAdmissionController({ rateWindowMs: 60000, rateMax: 100, maxInFlight: 4 }), modern), undefined, verifier);
        const accessToken = await token();
        const responses: string[] = [];
        for (const [method, name, params] of [
          ["tools/call", "searxng_web_search", { name: "searxng_web_search", arguments: { query: "oauth privacy fixture" } }],
          ["resources/read", "config://server-config", { uri: "config://server-config" }],
        ] as const) {
          const response = await request(resourceApp).post("/mcp").auth(accessToken, { type: "bearer" })
            .set("Accept", "application/json").set("MCP-Protocol-Version", "2026-07-28").set("MCP-Method", method).set("MCP-Name", name)
            .send({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} } } });
          assert.equal(response.status, 200, response.text);
          responses.push(response.text);
        }
        assert.ok(capture.getCapturedUrl().includes("oauth+privacy+fixture"));
        assert.ok(!JSON.stringify([capture.getCapturedUrl(), capture.getCapturedOptions(), responses, diagnostics]).includes(accessToken));
      } finally {
        console.warn = originalWarn;
        console.error = originalError;
        mocker.restore();
      }
    }, results);
  } finally {
    restoreProcessEnv(snapshot);
  }
  printTestSummary(results, "OAuth HTTP");
  return results;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) runTests().then(result => process.exit(result.failed ? 1 : 0));
