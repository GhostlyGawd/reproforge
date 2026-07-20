import { describe, expect, it, vi } from "vitest";

import type { AuthorizedPrincipal } from "@/application/authorization";
import { GitHubRepositoryProvider } from "@/github/repository-provider";

const principal: AuthorizedPrincipal = {
  callerId: "principal-alpha",
  principalId: "principal-alpha",
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
});
