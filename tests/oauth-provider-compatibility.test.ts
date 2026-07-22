import { describe, expect, it } from "vitest";

import {
  evaluateOAuthProviderCompatibility,
  type AuthorizationServerMetadata,
} from "@/auth/oauth-provider-compatibility";
import { parseOAuthResourceConfig } from "@/config/oauth";

const config = parseOAuthResourceConfig({
  AUTH0_DOMAIN: "tenant.us.auth0.com",
  REPROFORGE_BASE_URL: "https://reproforge.example/",
  REPROFORGE_OAUTH_TENANT_CLAIM: "https://reproforge.example/tenant_id",
});

const protectedResource = {
  authorization_servers: ["https://tenant.us.auth0.com/"],
  bearer_methods_supported: ["header"],
  resource: "https://reproforge.example/mcp",
  resource_name: "ReproForge",
  scopes_supported: [...config.scopes],
};

const discovery: AuthorizationServerMetadata = {
  authorization_endpoint: "https://tenant.us.auth0.com/authorize",
  code_challenge_methods_supported: ["S256"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  issuer: "https://tenant.us.auth0.com/",
  jwks_uri: "https://tenant.us.auth0.com/.well-known/jwks.json",
  registration_endpoint: "https://tenant.us.auth0.com/oidc/register",
  response_types_supported: ["code"],
  token_endpoint: "https://tenant.us.auth0.com/oauth/token",
  token_endpoint_auth_methods_supported: ["none"],
};

describe("OAuth provider compatibility", () => {
  it("accepts a ChatGPT-compatible DCR authorization server", () => {
    const report = evaluateOAuthProviderCompatibility({
      config,
      discovery,
      protectedResource,
    });

    expect(report.ok).toBe(true);
    expect(report.registrationMethod).toBe("dcr");
    expect(report.checks.every((check) => check.status === "pass")).toBe(true);
  });

  it("prefers CIMD when the authorization server advertises it", () => {
    const report = evaluateOAuthProviderCompatibility({
      config,
      discovery: {
        ...discovery,
        client_id_metadata_document_supported: true,
      },
      protectedResource,
    });

    expect(report.ok).toBe(true);
    expect(report.registrationMethod).toBe("cimd");
  });

  it("fails closed when the resource, issuer, or PKCE contract is altered", () => {
    const report = evaluateOAuthProviderCompatibility({
      config,
      discovery: {
        ...discovery,
        code_challenge_methods_supported: ["plain"],
        issuer: "https://attacker.example/",
      },
      protectedResource: {
        ...protectedResource,
        resource: "https://attacker.example/mcp",
      },
    });

    expect(report.ok).toBe(false);
    expect(report.checks.filter((check) => check.status === "fail").map((check) => check.id))
      .toEqual(expect.arrayContaining(["protected-resource", "issuer", "pkce"]));
  });

  it("rejects an authorization server without CIMD or DCR", () => {
    const withoutRegistration = { ...discovery };
    delete withoutRegistration.registration_endpoint;
    const report = evaluateOAuthProviderCompatibility({
      config,
      discovery: withoutRegistration,
      protectedResource,
    });

    expect(report.ok).toBe(false);
    expect(report.registrationMethod).toBe("none");
    expect(report.checks).toContainEqual({
      id: "client-registration",
      status: "fail",
    });
  });
});
