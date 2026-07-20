import { describe, expect, it } from "vitest";

import {
  OAuthVerificationError,
  createJwtAccessTokenVerifier,
} from "@/auth/access-token-verifier";
import { buildBearerChallenge } from "@/auth/challenge";
import {
  buildProtectedResourceMetadata,
  protectedResourceMetadataPath,
} from "@/auth/protected-resource";
import { parseOAuthResourceConfig } from "@/config/oauth";
import { createOAuthIssuerFixture } from "./helpers/oauth-issuer-fixture";

const oauthEnvironment = {
  AUTH0_DOMAIN: "issuer.reproforge.test",
  REPROFORGE_BASE_URL: "https://reproforge.test",
  REPROFORGE_OAUTH_TENANT_CLAIM:
    "https://reproforge.dev/tenant_id",
};

describe("OAuth protected-resource contract", () => {
  it("publishes exact HTTPS resource metadata without credentials", () => {
    const config = parseOAuthResourceConfig(oauthEnvironment);

    expect(protectedResourceMetadataPath).toBe(
      "/.well-known/oauth-protected-resource",
    );
    expect(buildProtectedResourceMetadata(config)).toEqual({
      authorization_servers: ["https://issuer.reproforge.test/"],
      bearer_methods_supported: ["header"],
      resource: "https://reproforge.test/mcp",
      resource_name: "ReproForge",
      scopes_supported: [
        "reproforge:account:delete",
        "reproforge:bundles:read",
        "reproforge:cases:read",
        "reproforge:cases:write",
        "reproforge:repositories:read",
      ],
    });
    expect(JSON.stringify(buildProtectedResourceMetadata(config))).not.toMatch(
      /secret|token|password/i,
    );
  });

  it("builds a standards-shaped, sanitized linking challenge", () => {
    const config = parseOAuthResourceConfig(oauthEnvironment);
    const challenge = buildBearerChallenge(config, {
      description:
        'Link ReproForge\r\nAuthorization: Bearer credential-shaped-value "now"',
      error: "invalid_token",
      scopes: [
        "reproforge:repositories:read",
        "reproforge:cases:write",
        "reproforge:repositories:read",
      ],
    });

    expect(challenge).toBe(
      'Bearer resource_metadata="https://reproforge.test/.well-known/oauth-protected-resource", scope="reproforge:cases:write reproforge:repositories:read", error="invalid_token", error_description="Link ReproForge Authorization: [REDACTED] now"',
    );
    expect(challenge).not.toContain("credential-shaped-value");
    expect(challenge).not.toContain("\r");
    expect(challenge).not.toContain("\n");
  });
});

describe("JWT access-token verification", () => {
  it("resolves a verified identity only after discovery, JWKS, and claim checks", async () => {
    const fixture = await createOAuthIssuerFixture();
    const verifier = createJwtAccessTokenVerifier({
      config: parseOAuthResourceConfig(oauthEnvironment),
      fetcher: fixture.fetcher,
      now: () => new Date(fixture.nowSeconds * 1_000),
    });

    await expect(
      verifier.verify(`Bearer ${await fixture.sign()}`),
    ).resolves.toEqual({
      expiresAt: fixture.nowSeconds + 300,
      issuer: fixture.issuer,
      scopes: [
        "reproforge:cases:read",
        "reproforge:repositories:read",
      ],
      subject: "auth0|principal-alpha",
      tenantId: "tenant-alpha",
    });
    expect(fixture.requests).toEqual([
      fixture.discoveryUrl,
      fixture.jwksUrl,
    ]);

    await verifier.verify(`Bearer ${await fixture.sign()}`);
    expect(fixture.requests).toEqual([
      fixture.discoveryUrl,
      fixture.jwksUrl,
    ]);
  });

  it.each([
    ["wrong issuer", { iss: "https://attacker.invalid/" }],
    ["wrong audience", { aud: "https://other-resource.invalid" }],
    ["expired", { exp: 1_799_999_999 }],
    ["not active", { nbf: 1_800_000_301 }],
    ["missing subject", { sub: "" }],
    [
      "missing tenant",
      { "https://reproforge.dev/tenant_id": "" },
    ],
    ["missing scope", { scope: "" }],
  ])("rejects a token with %s", async (_label, overrides) => {
    const fixture = await createOAuthIssuerFixture();
    const verifier = createJwtAccessTokenVerifier({
      config: parseOAuthResourceConfig(oauthEnvironment),
      fetcher: fixture.fetcher,
      now: () => new Date(fixture.nowSeconds * 1_000),
    });

    await expect(
      verifier.verify(`Bearer ${await fixture.sign(overrides)}`),
    ).rejects.toBeInstanceOf(OAuthVerificationError);
  });

  it("rejects absent, malformed, unknown-key, and unsupported-algorithm credentials", async () => {
    const fixture = await createOAuthIssuerFixture();
    const verifier = createJwtAccessTokenVerifier({
      config: parseOAuthResourceConfig(oauthEnvironment),
      fetcher: fixture.fetcher,
      now: () => new Date(fixture.nowSeconds * 1_000),
    });

    for (const authorization of [
      undefined,
      "Basic synthetic",
      "Bearer",
      "Bearer not-a-jwt",
      `Bearer ${await fixture.sign({ keyId: "unknown-key" })}`,
      `Bearer ${await fixture.signUnsupportedAlgorithm()}`,
    ]) {
      await expect(verifier.verify(authorization)).rejects.toBeInstanceOf(
        OAuthVerificationError,
      );
    }
  });
});
