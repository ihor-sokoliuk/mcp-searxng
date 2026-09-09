import {
  bearerAuthChallengeResponse,
  getOAuthProtectedResourceMetadataUrl,
  OAuthError,
  OAuthErrorCode,
  verifyBearerToken,
  type OAuthTokenVerifier,
} from "@modelcontextprotocol/server";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

export interface HttpOAuthConfig {
  issuer: string;
  jwksUrl: string;
  resource: string;
  scopes: string[];
}

function configuredUrl(name: string): string {
  const value = process.env[name]?.trim();
  try {
    const url = new URL(value ?? "");
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error();
    return value!;
  } catch {
    // Configuration values can contain credentials. Report only the variable.
    throw new Error(`${name} must be an absolute HTTPS URL without credentials, query or fragment.`);
  }
}

export function getHttpOAuthConfig(): HttpOAuthConfig | undefined {
  const mode = process.env.MCP_HTTP_AUTH_MODE?.trim() || "static";
  const names = ["MCP_HTTP_OAUTH_ISSUER", "MCP_HTTP_OAUTH_JWKS_URL", "MCP_HTTP_OAUTH_RESOURCE", "MCP_HTTP_OAUTH_SCOPES"];
  if (!["static", "oauth"].includes(mode)) throw new Error("MCP_HTTP_AUTH_MODE must be static or oauth.");
  if (mode !== "oauth") {
    if (names.some(name => process.env[name] !== undefined)) throw new Error("OAuth settings require MCP_HTTP_AUTH_MODE=oauth.");
    return undefined;
  }
  if (process.env.MCP_HTTP_AUTH_TOKEN !== undefined) throw new Error("OAuth mode cannot be combined with MCP_HTTP_AUTH_TOKEN.");
  const scopes = [...new Set((process.env.MCP_HTTP_OAUTH_SCOPES ?? "").trim().split(/\s+/).filter(Boolean))];
  if (!scopes.length || scopes.some(scope => !/^[\x21\x23-\x5B\x5D-\x7E]+$/.test(scope))) {
    throw new Error("MCP_HTTP_OAUTH_SCOPES requires space-separated OAuth scope names.");
  }
  return {
    issuer: configuredUrl("MCP_HTTP_OAUTH_ISSUER"),
    jwksUrl: configuredUrl("MCP_HTTP_OAUTH_JWKS_URL"),
    resource: configuredUrl("MCP_HTTP_OAUTH_RESOURCE"),
    scopes,
  };
}

export function createJwtVerifier(config: HttpOAuthConfig, key: JWTVerifyGetKey = createRemoteJWKSet(new URL(config.jwksUrl))): OAuthTokenVerifier {
  return {
    async verifyAccessToken(token) {
      try {
        const { payload } = await jwtVerify(token, key, {
          issuer: config.issuer,
          audience: config.resource,
          typ: "at+jwt",
          algorithms: ["RS256", "PS256", "ES256", "EdDSA"],
          requiredClaims: ["exp", "iat", "sub", "client_id", "jti"],
        });
        if (typeof payload.client_id !== "string" || !payload.client_id || typeof payload.sub !== "string" || !payload.sub || typeof payload.jti !== "string" || !payload.jti || typeof payload.scope !== "string") throw new Error();
        return { token, clientId: payload.client_id, scopes: payload.scope.split(" ").filter(Boolean), expiresAt: payload.exp };
      } catch {
        // Never expose JWTs, claims, JWKS URLs, or provider errors to clients/logs.
        throw new OAuthError(OAuthErrorCode.InvalidToken, "Invalid access token");
      }
    },
  };
}

export function createOAuthProtection(config: HttpOAuthConfig, verifier = createJwtVerifier(config)) {
  const metadataUrl = getOAuthProtectedResourceMetadataUrl(new URL(config.resource));
  const options = { verifier, requiredScopes: config.scopes, resourceMetadataUrl: metadataUrl };
  return {
    metadataPath: new URL(metadataUrl).pathname,
    metadata: { resource: config.resource, authorization_servers: [config.issuer], scopes_supported: config.scopes, bearer_methods_supported: ["header"] },
    async authorize(header: string | undefined): Promise<Response | undefined> {
      try {
        await verifyBearerToken(header, options);
        return undefined;
      } catch (error) {
        return bearerAuthChallengeResponse(error, options);
      }
    },
  };
}
