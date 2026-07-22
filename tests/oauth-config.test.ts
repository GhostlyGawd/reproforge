import { describe, expect, it, vi } from "vitest";

import { createProtectedResourceMetadataHandler } from "@/auth/protected-resource";
import {
  OAuthConfigurationError,
  createOAuthResourceConfigLoader,
  parseOAuthResourceConfig,
} from "@/config/oauth";

const environment = {
  AUTH0_DOMAIN: "tenant.us.auth0.com",
  REPROFORGE_BASE_URL: "https://reproforge.example",
  REPROFORGE_OAUTH_TENANT_CLAIM: "https://reproforge.dev/tenant_id",
};

describe("OAuth resource configuration", () => {
  it("derives one canonical resource, issuer, discovery URL, and metadata URL", () => {
    expect(parseOAuthResourceConfig(environment)).toMatchObject({
      authorizationServer: "https://tenant.us.auth0.com/",
      baseUrl: "https://reproforge.example/",
      discoveryUrl:
        "https://tenant.us.auth0.com/.well-known/openid-configuration",
      metadataUrl:
        "https://reproforge.example/.well-known/oauth-protected-resource",
      resource: "https://reproforge.example/mcp",
    });
  });

  it.each([
    ["missing domain", { ...environment, AUTH0_DOMAIN: undefined }],
    ["domain scheme", { ...environment, AUTH0_DOMAIN: "https://tenant.auth0.com" }],
    ["HTTP base", { ...environment, REPROFORGE_BASE_URL: "http://reproforge.example" }],
    ["base path", { ...environment, REPROFORGE_BASE_URL: "https://reproforge.example/app" }],
    ["credentialed base", { ...environment, REPROFORGE_BASE_URL: "https://user:pass@reproforge.example" }],
    ["missing tenant claim", { ...environment, REPROFORGE_OAUTH_TENANT_CLAIM: undefined }],
    ["non-HTTPS tenant claim", { ...environment, REPROFORGE_OAUTH_TENANT_CLAIM: "tenant_id" }],
  ])("fails closed for %s without exposing values", (_label, candidate) => {
    expect(() => parseOAuthResourceConfig(candidate)).toThrowError(
      OAuthConfigurationError,
    );
    try {
      parseOAuthResourceConfig(candidate);
    } catch (error) {
      expect(String(error)).not.toContain("user:pass");
    }
  });

  it("loads lazily and memoizes both success and failure", () => {
    const readSuccess = vi.fn(() => environment);
    const success = createOAuthResourceConfigLoader(readSuccess);
    expect(readSuccess).not.toHaveBeenCalled();
    expect(success().resource).toBe("https://reproforge.example/mcp");
    expect(success().resource).toBe("https://reproforge.example/mcp");
    expect(readSuccess).toHaveBeenCalledTimes(1);

    const readFailure = vi.fn(() => ({}));
    const failure = createOAuthResourceConfigLoader(readFailure);
    expect(() => failure()).toThrowError(OAuthConfigurationError);
    expect(() => failure()).toThrowError(OAuthConfigurationError);
    expect(readFailure).toHaveBeenCalledTimes(1);
  });
});

describe("protected-resource metadata handler", () => {
  it("returns cacheable JSON when configuration is valid", async () => {
    const response = createProtectedResourceMetadataHandler(() =>
      parseOAuthResourceConfig(environment),
    )();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    await expect(response.json()).resolves.toMatchObject({
      resource: "https://reproforge.example/mcp",
    });
  });

  it("returns a sanitized, non-cacheable 503 when configuration is absent", async () => {
    const response = createProtectedResourceMetadataHandler(() => {
      throw new Error("secret-auth0-configuration");
    })();

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = JSON.stringify(await response.json());
    expect(body).toBe('{"error":"oauth_configuration_unavailable"}');
    expect(body).not.toContain("secret-auth0-configuration");
  });
});
