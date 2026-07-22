import { generateKeyPairSync } from "node:crypto";

import { decodeProtectedHeader, decodeJwt } from "jose";
import { describe, expect, it, vi } from "vitest";

import { GitHubAppClient } from "@/github/app-client";

const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ format: "pem", type: "pkcs1" })
  .toString();

const config = {
  apiBaseUrl: "https://api.github.com/",
  appId: "12345",
  clientId: "Iv1.synthetic-client",
  clientSecret: "synthetic-client-secret-123456",
  privateKey,
};
const now = new Date("2026-07-20T00:00:00.000Z");

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

describe("GitHub App API client", () => {
  it("proves the setup actor, verifies the installation, and returns sanitized repository metadata", async () => {
    const calls: Array<{ body: string; headers: Headers; method: string; url: string }> = [];
    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({
        body: String(init?.body ?? ""),
        headers: new Headers(init?.headers),
        method: init?.method ?? "GET",
        url,
      });
      if (url === "https://github.com/login/oauth/access_token") {
        return json({ access_token: "ghu_transient-user-token", token_type: "bearer" });
      }
      if (url.endsWith("/user/installations?per_page=100&page=1")) {
        return json({ installations: [{ id: 7001 }], total_count: 1 });
      }
      if (url.endsWith("/app/installations/7001")) {
        return json({
          account: { id: 9001, login: "synthetic-owner" },
          id: 7001,
          permissions: { contents: "read", issues: "read", metadata: "read" },
          repository_selection: "selected",
          suspended_at: null,
        });
      }
      if (url.endsWith("/app/installations/7001/access_tokens")) {
        return json({
          expires_at: "2026-07-20T00:59:00.000Z",
          permissions: { contents: "read", issues: "read", metadata: "read" },
          repository_selection: "selected",
          token: "ghs_12345_synthetic-installation-token",
        }, 201);
      }
      if (url.endsWith("/installation/repositories?per_page=100&page=1")) {
        return json({
          repositories: [{
            default_branch: "main",
            full_name: "synthetic-owner/private-canary",
            id: 8001,
            private: true,
          }],
          total_count: 1,
        });
      }
      return json({ message: "unexpected" }, 500);
    });

    const client = new GitHubAppClient(config, {
      clock: { now: () => now },
      fetch: request as typeof fetch,
    });
    const verified = await client.verify({
      code: "synthetic-setup-code",
      installationId: 7001,
    });

    expect(verified).toEqual({
      accountId: 9001,
      accountLogin: "synthetic-owner",
      installationId: 7001,
      permissions: { contents: "read", issues: "read", metadata: "read" },
      repositories: [{
        defaultBranch: "main",
        fullName: "synthetic-owner/private-canary",
        private: true,
        repositoryId: 8001,
      }],
      repositorySelection: "selected",
    });
    expect(JSON.stringify(verified)).not.toMatch(/ghu_|ghs_|client-secret/);

    const appRequests = calls.filter((call) =>
      call.headers.get("authorization")?.startsWith("Bearer ey"),
    );
    expect(appRequests.length).toBeGreaterThan(0);
    const appJwt = appRequests[0]?.headers.get("authorization")?.slice(7) ?? "";
    expect(decodeProtectedHeader(appJwt)).toEqual({ alg: "RS256", typ: "JWT" });
    expect(decodeJwt(appJwt)).toMatchObject({ iss: config.clientId });
    expect(calls.at(-1)?.headers.get("authorization")).toBe(
      "Bearer ghs_12345_synthetic-installation-token",
    );
  });

  it("reads an authoritative installation snapshot without a setup actor token", async () => {
    const urls: string[] = [];
    const request = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith("/app/installations/7001")) {
        return json({
          account: { id: 9001, login: "synthetic-owner" },
          id: 7001,
          permissions: { contents: "read", issues: "read", metadata: "read" },
          repository_selection: "selected",
          suspended_at: null,
          updated_at: "2026-07-20T00:03:00.000Z",
        });
      }
      if (url.endsWith("/app/installations/7001/access_tokens")) {
        return json(
          {
            expires_at: "2026-07-20T00:59:00.000Z",
            permissions: { contents: "read", issues: "read", metadata: "read" },
            repository_selection: "selected",
            token: "ghs_12345_refresh-token",
          },
          201,
        );
      }
      if (url.endsWith("/installation/repositories?per_page=100&page=1")) {
        return json({
          repositories: [
            {
              default_branch: "main",
              full_name: "synthetic-owner/repository-canary",
              id: 8003,
              private: false,
            },
          ],
          total_count: 1,
        });
      }
      return json({}, 500);
    });
    const client = new GitHubAppClient(config, {
      clock: { now: () => now },
      fetch: request as typeof fetch,
    });

    await expect(client.readInstallation(7001)).resolves.toEqual({
      accountId: 9001,
      accountLogin: "synthetic-owner",
      installationId: 7001,
      permissions: { contents: "read", issues: "read", metadata: "read" },
      providerUpdatedAt: "2026-07-20T00:03:00.000Z",
      repositories: [
        {
          defaultBranch: "main",
          fullName: "synthetic-owner/repository-canary",
          private: false,
          repositoryId: 8003,
        },
      ],
      repositorySelection: "selected",
    });
    expect(urls.some((url) => url.includes("/user/installations"))).toBe(false);
    expect(urls).not.toContain("https://github.com/login/oauth/access_token");
  });

  it("rechecks live authorization and scopes each revision token to one repository", async () => {
    const sha = "a".repeat(40);
    const requests: Array<{ body: string; url: string }> = [];
    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ body: String(init?.body ?? ""), url });
      if (url.endsWith("/app/installations/7001")) {
        return json({
          account: { id: 9001, login: "synthetic-owner" },
          id: 7001,
          permissions: { contents: "read", issues: "read", metadata: "read" },
          repository_selection: "selected",
          suspended_at: null,
        });
      }
      if (url.endsWith("/app/installations/7001/access_tokens")) {
        return json({
          expires_at: "2026-07-20T00:59:00.000Z",
          permissions: { contents: "read", issues: "read", metadata: "read" },
          repository_selection: "selected",
          token: "ghs_12345_revision-token",
        }, 201);
      }
      if (url.endsWith(`/repos/synthetic-owner/private-canary/commits/${sha}`)) {
        return json({ sha });
      }
      return json({}, 500);
    });
    const client = new GitHubAppClient(config, {
      clock: { now: () => now },
      fetch: request as typeof fetch,
    });

    await expect(
      client.assertRepositoryRevision({
        commitSha: sha,
        fullName: "synthetic-owner/private-canary",
        installationId: 7001,
        providerRepositoryId: 8001,
      }),
    ).resolves.toEqual({ commitSha: sha });
    expect(
      JSON.parse(
        requests.find((item) => item.url.endsWith("/access_tokens"))?.body ?? "{}",
      ),
    ).toEqual({
      permissions: { contents: "read", issues: "read", metadata: "read" },
      repository_ids: [8001],
    });
    expect(JSON.stringify(requests)).not.toContain("synthetic-client-secret-123456");
  });

  it("fails closed with a sanitized error when installation authorization is suspended", async () => {
    const request = vi.fn(async () =>
      json({
        account: { id: 9001, login: "synthetic-owner" },
        id: 7001,
        permissions: { contents: "read", issues: "read", metadata: "read" },
        repository_selection: "selected",
        suspended_at: "2026-07-20T00:00:00.000Z",
      }),
    );
    const client = new GitHubAppClient(config, {
      clock: { now: () => now },
      fetch: request as typeof fetch,
    });

    await expect(
      client.assertRepositoryRevision({
        commitSha: "a".repeat(40),
        fullName: "synthetic-owner/private-canary",
        installationId: 7001,
        providerRepositoryId: 8001,
      }),
    ).rejects.toMatchObject({ code: "INSTALLATION_UNAVAILABLE" });
    await expect(
      client.assertRepositoryRevision({
        commitSha: "a".repeat(40),
        fullName: "synthetic-owner/private-canary",
        installationId: 7001,
        providerRepositoryId: 8001,
      }),
    ).rejects.not.toThrow(/synthetic-client-secret|private-canary/);
  });

  it("leases one repository-scoped archive credential only for the callback", async () => {
    const requests: Array<{ body: string; url: string }> = [];
    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ body: String(init?.body ?? ""), url });
      if (url.endsWith("/app/installations/7001")) {
        return json({
          account: { id: 9001, login: "synthetic-owner" },
          id: 7001,
          permissions: { contents: "read", issues: "read", metadata: "read" },
          repository_selection: "selected",
          suspended_at: null,
        });
      }
      if (url.endsWith("/app/installations/7001/access_tokens")) {
        return json(
          {
            expires_at: "2026-07-20T00:59:00.000Z",
            permissions: { contents: "read", issues: "read", metadata: "read" },
            repository_selection: "selected",
            token: "ghs_synthetic-archive-token",
          },
          201,
        );
      }
      return json({}, 500);
    });
    const client = new GitHubAppClient(config, {
      clock: { now: () => now },
      fetch: request as typeof fetch,
    });
    const consume = vi.fn(async (credential: {
      authorizationHeader: string;
      expiresAt: string;
    }) => {
      expect(credential).toEqual({
        authorizationHeader: "Bearer ghs_synthetic-archive-token",
        expiresAt: "2026-07-20T00:59:00.000Z",
      });
      return "archive-acquired";
    });

    await expect(
      client.withRepositoryArchiveCredential(
        { installationId: 7001, providerRepositoryId: 8001 },
        consume,
      ),
    ).resolves.toBe("archive-acquired");
    expect(consume).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse(
        requests.find((item) => item.url.endsWith("/access_tokens"))?.body ??
          "{}",
      ),
    ).toMatchObject({ repository_ids: [8001] });
  });
});
