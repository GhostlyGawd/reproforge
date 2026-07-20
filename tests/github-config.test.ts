import { describe, expect, it, vi } from "vitest";

import {
  GitHubConfigurationError,
  createGitHubConfigLoader,
  parseGitHubConfig,
  summarizeGitHubConfig,
} from "@/config/github";

const environment = {
  GITHUB_APP_CLIENT_ID: "Iv1.synthetic-client",
  GITHUB_APP_CLIENT_SECRET: "synthetic-client-secret-123456",
  GITHUB_APP_ID: "12345",
  GITHUB_APP_PRIVATE_KEY:
    "-----BEGIN PRIVATE KEY-----\n" + "a".repeat(256) + "\n-----END PRIVATE KEY-----",
  GITHUB_APP_SLUG: "reproforge-development",
  GITHUB_WEBHOOK_SECRET: "synthetic-webhook-secret-with-entropy",
  REPROFORGE_BASE_URL: "https://reproforge.example",
};

describe("GitHub App configuration", () => {
  it("parses a canonical server-only configuration and emits a credential-free summary", () => {
    const config = parseGitHubConfig(environment);
    expect(config).toMatchObject({
      apiBaseUrl: "https://api.github.com/",
      appId: "12345",
      appSlug: "reproforge-development",
      baseUrl: "https://reproforge.example/",
      clientId: "Iv1.synthetic-client",
    });
    expect(config.credentials).toMatchObject({
      clientSecret: environment.GITHUB_APP_CLIENT_SECRET,
      privateKey: environment.GITHUB_APP_PRIVATE_KEY,
      webhookSecret: environment.GITHUB_WEBHOOK_SECRET,
    });
    const summary = JSON.stringify(summarizeGitHubConfig(config));
    expect(summary).toContain('"appSlug":"reproforge-development"');
    expect(summary).not.toContain(environment.GITHUB_APP_CLIENT_SECRET);
    expect(summary).not.toContain(environment.GITHUB_APP_PRIVATE_KEY);
    expect(summary).not.toContain(environment.GITHUB_WEBHOOK_SECRET);
  });

  it.each([
    ["missing app id", { ...environment, GITHUB_APP_ID: undefined }],
    ["invalid slug", { ...environment, GITHUB_APP_SLUG: "Bad Slug" }],
    ["HTTP origin", { ...environment, REPROFORGE_BASE_URL: "http://example.com" }],
    ["credentialed origin", { ...environment, REPROFORGE_BASE_URL: "https://u:p@example.com" }],
    ["malformed key", { ...environment, GITHUB_APP_PRIVATE_KEY: "synthetic-private-key" }],
    ["short webhook secret", { ...environment, GITHUB_WEBHOOK_SECRET: "short" }],
  ])("fails closed for %s without exposing the candidate", (_label, candidate) => {
    expect(() => parseGitHubConfig(candidate)).toThrowError(GitHubConfigurationError);
    try {
      parseGitHubConfig(candidate);
    } catch (error) {
      expect(String(error)).not.toMatch(/synthetic-client-secret|synthetic-private-key|u:p/);
    }
  });

  it("loads once and memoizes both success and failure", () => {
    const successRead = vi.fn(() => environment);
    const success = createGitHubConfigLoader(successRead);
    expect(successRead).not.toHaveBeenCalled();
    expect(success().appId).toBe("12345");
    expect(success().appId).toBe("12345");
    expect(successRead).toHaveBeenCalledTimes(1);

    const failureRead = vi.fn(() => ({}));
    const failure = createGitHubConfigLoader(failureRead);
    expect(() => failure()).toThrowError(GitHubConfigurationError);
    expect(() => failure()).toThrowError(GitHubConfigurationError);
    expect(failureRead).toHaveBeenCalledTimes(1);
  });
});
