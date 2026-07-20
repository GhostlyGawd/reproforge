import { describe, expect, it, vi } from "vitest";

import type { AuthorizedPrincipal } from "@/application/authorization";
import { GitHubRepositoryProvider } from "@/github/repository-provider";

const principal: AuthorizedPrincipal = {
  callerId: "principal-alpha",
  expiresAt: 1_774_224_000,
  issuer: "https://issuer.example/",
  principalId: "principal-alpha",
  scopes: ["reproforge:repositories:read"],
  subject: "auth0|principal-alpha",
  tenantId: "tenant-alpha",
};

const repository = {
  defaultBranch: "main",
  fullName: "synthetic-owner/private-canary",
  installationId: 7001,
  permissions: { contents: "read" as const, issues: "read" as const, metadata: "read" as const },
  private: true,
  providerRepositoryId: 8001,
  repositoryId: "repo_alpha",
  status: "ACTIVE" as const,
  tenantId: principal.tenantId,
};

describe("provider-neutral repository authorization", () => {
  it("lists only the principal tenant and resolves a live immutable revision", async () => {
    const store = {
      findRepository: vi.fn(async () => repository),
      listRepositories: vi.fn(async () => ({
        nextCursor: null,
        repositories: [repository],
      })),
    };
    const live = {
      assertRepositoryRevision: vi.fn(async ({ commitSha }: { commitSha: string }) => ({ commitSha })),
    };
    const provider = new GitHubRepositoryProvider(store, live);

    await expect(
      provider.listAuthorizedRepositories(principal, { limit: 10 }),
    ).resolves.toEqual({
      nextCursor: null,
      repositories: [{
        defaultBranch: "main",
        fullName: "synthetic-owner/private-canary",
        private: true,
        repositoryId: "repo_alpha",
      }],
      tenantId: "tenant-alpha",
    });
    const sha = "b".repeat(40);
    await expect(
      provider.resolveRevision(principal, {
        commitSha: sha,
        repositoryId: "repo_alpha",
      }),
    ).resolves.toEqual({
      commitSha: sha,
      defaultBranch: "main",
      fullName: "synthetic-owner/private-canary",
      private: true,
      provider: "github",
      repositoryId: "repo_alpha",
    });
    expect(store.findRepository).toHaveBeenCalledWith(
      "tenant-alpha",
      "repo_alpha",
    );
    expect(live.assertRepositoryRevision).toHaveBeenCalledWith({
      commitSha: sha,
      fullName: repository.fullName,
      installationId: repository.installationId,
      providerRepositoryId: repository.providerRepositoryId,
    });
  });

  it("returns the same non-disclosing error for missing, removed, or cross-tenant repositories", async () => {
    for (const candidate of [null, { ...repository, status: "REMOVED" as const }]) {
      const provider = new GitHubRepositoryProvider(
        {
          findRepository: vi.fn(async () => candidate),
          listRepositories: vi.fn(),
        },
        { assertRepositoryRevision: vi.fn() },
      );
      await expect(
        provider.resolveRevision(principal, {
          commitSha: "b".repeat(40),
          repositoryId: "repo_unknown",
        }),
      ).rejects.toMatchObject({ code: "REPOSITORY_NOT_FOUND" });
    }
  });

  it("audits repository access and denial without repository names or credentials", async () => {
    const append = vi.fn(async () => undefined);
    const store = {
      findRepository: vi
        .fn()
        .mockResolvedValueOnce(repository)
        .mockResolvedValueOnce(null),
      listRepositories: vi.fn(),
    };
    let sequence = 0;
    const provider = new GitHubRepositoryProvider(
      store,
      {
        assertRepositoryRevision: vi.fn(async ({ commitSha }) => ({ commitSha })),
      },
      {
        audit: { append },
        clock: { now: () => new Date("2026-07-20T00:00:00.000Z") },
        eventId: () => `audit_repository_${++sequence}`,
      },
    );
    const input = { commitSha: "c".repeat(40), repositoryId: "repo_alpha" };

    await provider.resolveRevision(principal, input);
    await expect(provider.resolveRevision(principal, input)).rejects.toMatchObject({
      code: "REPOSITORY_NOT_FOUND",
    });
    expect(append).toHaveBeenCalledTimes(2);
    expect(append.mock.calls.map(([event]) => event)).toEqual([
      expect.objectContaining({
        action: "github.repository-accessed",
        outcome: "success",
        targetId: "repo_alpha",
      }),
      expect.objectContaining({
        action: "github.repository-access-denied",
        outcome: "denied",
        targetId: "repo_alpha",
      }),
    ]);
    expect(JSON.stringify(append.mock.calls)).not.toMatch(
      /private-canary|ghs_|authorization|secret/i,
    );
  });
});
