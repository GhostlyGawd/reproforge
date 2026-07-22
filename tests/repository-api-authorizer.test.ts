import { describe, expect, it, vi } from "vitest";

import type { AccessTokenVerifier } from "@/application/ports/auth";
import type { PrincipalDirectory } from "@/application/ports/identity";
import { OAuthVerificationError } from "@/auth/access-token-verifier";
import { createRepositoryApiAuthorizer } from "@/auth/repository-api-authorizer";
import type { OAuthResourceConfig } from "@/config/oauth";

const config: OAuthResourceConfig = {
  authorizationServer: "https://tenant.example/",
  baseUrl: "https://reproforge.example/",
  discoveryUrl: "https://tenant.example/.well-known/openid-configuration",
  metadataUrl:
    "https://reproforge.example/.well-known/oauth-protected-resource",
  resource: "https://reproforge.example/mcp",
  scopes: [
    "reproforge:account:delete",
    "reproforge:bundles:read",
    "reproforge:cases:read",
    "reproforge:cases:write",
    "reproforge:repositories:read",
  ],
  tenantClaim: "https://reproforge.example/tenant_id",
};

const token = {
  expiresAt: 2_000_000_000,
  issuer: config.authorizationServer,
  scopes: ["reproforge:cases:read" as const],
  subject: "auth0|repository-rest",
  tenantId: "tenant_repository_rest",
};

function verifier(): AccessTokenVerifier {
  return { verify: vi.fn(async () => token) };
}

function directory(): PrincipalDirectory {
  return {
    resolve: vi.fn(async () => ({
      principalId: "principal_repository_rest",
      status: "ACTIVE" as const,
      tenantId: token.tenantId,
    })),
  };
}

describe("repository API bearer authorization", () => {
  it("maps a verified bearer subject to the durable tenant principal", async () => {
    const accessTokens = verifier();
    const principals = directory();
    const result = await createRepositoryApiAuthorizer({
      config,
      directory: principals,
      verifier: accessTokens,
    })(
      new Request("https://reproforge.example/api/v2/reproductions", {
        headers: { Authorization: "Bearer synthetic-token" },
      }),
      ["reproforge:cases:read"],
    );

    expect(result).toEqual({
      ok: true,
      principal: {
        callerId: "principal_repository_rest",
        principalId: "principal_repository_rest",
        tenantId: token.tenantId,
      },
    });
    expect(accessTokens.verify).toHaveBeenCalledWith(
      "Bearer synthetic-token",
    );
    expect(principals.resolve).toHaveBeenCalledWith({
      issuer: token.issuer,
      subject: token.subject,
    });
  });

  it("returns only missing least-privilege scopes in a bearer challenge", async () => {
    const result = await createRepositoryApiAuthorizer({
      config,
      directory: directory(),
      verifier: verifier(),
    })(new Request("https://reproforge.example/api/v2/reproductions"), [
      "reproforge:cases:read",
      "reproforge:repositories:read",
    ]);

    expect(result).toMatchObject({
      code: "INSUFFICIENT_SCOPE",
      ok: false,
      status: 403,
    });
    if (result.ok) throw new Error("Expected an authorization challenge");
    expect(result.challenge).toContain(
      'scope="reproforge:repositories:read"',
    );
    expect(result.challenge).not.toContain(
      "reproforge:cases:read reproforge:repositories:read",
    );
  });

  it("returns an account-linking challenge for a missing bearer token", async () => {
    const result = await createRepositoryApiAuthorizer({
      config,
      directory: directory(),
      verifier: {
        verify: async () => {
          throw new OAuthVerificationError(
            "MISSING_TOKEN",
            "A bearer token is required",
          );
        },
      },
    })(new Request("https://reproforge.example/api/v2/reproductions"), [
      "reproforge:cases:read",
    ]);

    expect(result).toMatchObject({
      code: "AUTHENTICATION_REQUIRED",
      ok: false,
      status: 401,
    });
    if (result.ok) throw new Error("Expected an authentication challenge");
    expect(result.challenge).toContain('error="invalid_token"');
  });

  it("fails closed without leaking verifier or principal errors", async () => {
    const result = await createRepositoryApiAuthorizer({
      config,
      directory: directory(),
      verifier: {
        verify: async () => {
          throw new Error("secret verifier detail");
        },
      },
    })(new Request("https://reproforge.example/api/v2/reproductions"), [
      "reproforge:cases:read",
    ]);

    expect(result).toMatchObject({
      code: "AUTHORIZATION_UNAVAILABLE",
      message: "ReproForge authorization is temporarily unavailable",
      ok: false,
      status: 503,
    });
    expect(JSON.stringify(result)).not.toContain("secret verifier detail");
  });
});
