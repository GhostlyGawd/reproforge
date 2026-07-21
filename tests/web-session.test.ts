import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  WebAuthenticationConfigurationError,
  parseWebAuthenticationConfig,
  summarizeWebAuthenticationConfig,
} from "@/config/web-auth";
import {
  WebSessionError,
  projectWebAccount,
  resolveWebIdentity,
} from "@/auth/web-session";

const environment = {
  APP_BASE_URL: "https://reproforge.example",
  AUTH0_CLIENT_ID: "synthetic-client-id",
  AUTH0_CLIENT_SECRET: "synthetic-client-secret",
  AUTH0_DOMAIN: "tenant.us.auth0.com",
  AUTH0_SECRET: "a".repeat(64),
  REPROFORGE_OAUTH_TENANT_CLAIM: "https://reproforge.dev/tenant_id",
};

describe("web authentication configuration", () => {
  it("configures a regular web client for the same resource audience", () => {
    const config = parseWebAuthenticationConfig(environment);
    expect(config).toMatchObject({
      appBaseUrl: "https://reproforge.example/",
      audience: "https://reproforge.example/mcp",
      clientId: "synthetic-client-id",
      domain: "tenant.us.auth0.com",
      scopes: [
        "openid",
        "profile",
        "email",
        "reproforge:bundles:read",
        "reproforge:cases:read",
        "reproforge:cases:write",
        "reproforge:repositories:read",
      ],
      tenantClaim: "https://reproforge.dev/tenant_id",
    });
    const summary = JSON.stringify(summarizeWebAuthenticationConfig(config));
    expect(summary).not.toContain(environment.AUTH0_CLIENT_SECRET);
    expect(summary).not.toContain(environment.AUTH0_SECRET);
    expect(summary).toContain('"cookieHttpOnly":true');
    expect(summary).toContain('"sameSite":"lax"');
  });

  it.each([
    ["HTTP base", { ...environment, APP_BASE_URL: "http://reproforge.example" }],
    ["missing client", { ...environment, AUTH0_CLIENT_ID: undefined }],
    ["missing client secret", { ...environment, AUTH0_CLIENT_SECRET: undefined }],
    ["short cookie secret", { ...environment, AUTH0_SECRET: "too-short" }],
    ["invalid domain", { ...environment, AUTH0_DOMAIN: "https://tenant.auth0.com" }],
  ])("fails closed for %s without echoing credential values", (_label, candidate) => {
    expect(() => parseWebAuthenticationConfig(candidate)).toThrowError(
      WebAuthenticationConfigurationError,
    );
    try {
      parseWebAuthenticationConfig(candidate);
    } catch (error) {
      expect(String(error)).not.toContain("too-short");
      expect(String(error)).not.toContain("synthetic-client-secret");
    }
  });
});

describe("server-side web session projection", () => {
  const session = {
    accessTokens: [
      {
        accessToken: "secondary-access-token",
        audience: "https://reproforge.example/mcp",
        expiresAt: 1_800_000_300,
      },
    ],
    internal: { createdAt: 1_800_000_000, sid: "private-session-id" },
    tokenSet: {
      accessToken: "primary-access-token",
      expiresAt: 1_800_000_300,
      idToken: "private-id-token",
      refreshToken: "private-refresh-token",
    },
    user: {
      "https://reproforge.dev/tenant_id": "tenant-alpha",
      email: "builder@example.test",
      iss: "https://tenant.us.auth0.com/",
      name: "Synthetic Builder",
      picture: "https://images.example.test/avatar.png",
      sub: "auth0|principal-alpha",
    },
  };

  it("keeps issuer/subject/tenant server-side and exposes a minimal account view", () => {
    const identity = resolveWebIdentity(
      session,
      "https://reproforge.dev/tenant_id",
    );
    expect(identity).toEqual({
      email: "builder@example.test",
      issuer: "https://tenant.us.auth0.com/",
      name: "Synthetic Builder",
      picture: "https://images.example.test/avatar.png",
      subject: "auth0|principal-alpha",
      tenantId: "tenant-alpha",
    });

    const account = projectWebAccount(identity);
    expect(account).toEqual({
      displayName: "Synthetic Builder",
      email: "builder@example.test",
      picture: "https://images.example.test/avatar.png",
      signedIn: true,
    });
    const serialized = JSON.stringify(account);
    for (const forbidden of [
      "primary-access-token",
      "secondary-access-token",
      "private-id-token",
      "private-refresh-token",
      "private-session-id",
      "auth0|principal-alpha",
      "tenant-alpha",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("derives the same stable tenant as the Auth0 Action when the ID token omits the custom claim", () => {
    const user = { ...session.user } as Record<string, unknown>;
    delete user["https://reproforge.dev/tenant_id"];
    const identity = resolveWebIdentity(
      { ...session, user },
      "https://reproforge.dev/tenant_id",
    );

    expect(identity.tenantId).toBe(
      `tenant_${createHash("sha256").update(session.user.sub, "utf8").digest("hex")}`,
    );
  });

  it.each([
    ["missing session", null, "invalid_session"],
    [
      "missing issuer",
      { ...session, user: { ...session.user, iss: "" } },
      "invalid_issuer",
    ],
    [
      "missing subject",
      { ...session, user: { ...session.user, sub: "" } },
      "invalid_subject",
    ],
    [
      "missing tenant",
      {
        ...session,
        user: {
          ...session.user,
          "https://reproforge.dev/tenant_id": "",
        },
      },
      "invalid_tenant",
    ],
  ])("fails closed for %s", (_label, candidate, reason) => {
    try {
      resolveWebIdentity(candidate, "https://reproforge.dev/tenant_id");
      throw new Error("expected the session to fail closed");
    } catch (error) {
      expect(error).toBeInstanceOf(WebSessionError);
      expect(error).toMatchObject({ reason });
    }
  });
});
