import { describe, expect, it, vi } from "vitest";

import { createGitHubInstallHandler } from "@/github/install-route";
import { InMemoryGitHubInstallationStateStore } from "@/github/installation-state";

describe("GitHub App install route", () => {
  it("redirects a signed-in actor through a short-lived state-bound install URL", async () => {
    const states = new InMemoryGitHubInstallationStateStore();
    const actor = vi.fn(async () => ({
      principalId: "principal-alpha",
      tenantId: "tenant-alpha",
    }));
    const handler = createGitHubInstallHandler({
      actor,
      appSlug: "reproforge-development",
      baseUrl: "https://reproforge.example/",
      clock: { now: () => new Date("2026-07-20T00:00:00.000Z") },
      randomBytes: () => Buffer.alloc(32, 3),
      states,
    });

    const response = await handler();
    expect(response.status).toBe(303);
    const destination = response.headers.get("location") ?? "";
    expect(destination).toMatch(
      /^https:\/\/github\.com\/apps\/reproforge-development\/installations\/new\?state=[A-Za-z0-9_-]{43}$/,
    );
    expect(destination).not.toMatch(/tenant-alpha|principal-alpha/);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(states.snapshot()).toHaveLength(1);
  });

  it("sends a signed-out visitor to Auth0 without creating installation state", async () => {
    const states = new InMemoryGitHubInstallationStateStore();
    const handler = createGitHubInstallHandler({
      actor: async () => null,
      appSlug: "reproforge-development",
      baseUrl: "https://reproforge.example/",
      states,
    });

    const response = await handler();
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://reproforge.example/auth/login?returnTo=%2Frepositories",
    );
    expect(states.snapshot()).toEqual([]);
  });

  it("returns a sanitized non-cacheable failure when composition is unavailable", async () => {
    const failure = new Error("synthetic-database-secret");
    const onError = vi.fn();
    const handler = createGitHubInstallHandler({
      actor: async () => {
        throw failure;
      },
      appSlug: "reproforge-development",
      baseUrl: "https://reproforge.example/",
      onError,
      states: new InMemoryGitHubInstallationStateStore(),
    });

    const response = await handler();
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.text();
    expect(body).toBe('{"error":"github_installation_unavailable"}');
    expect(body).not.toContain("synthetic-database-secret");
    expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
  });
});
