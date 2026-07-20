import { z } from "zod";

import type { AuthorizedPrincipal } from "@/application/authorization";
import type { RepositorySourceProvider } from "@/application/ports/repository-source";
import type { GitHubAuthorizationStore } from "@/github/authorization-store";

type Catalog = Pick<
  GitHubAuthorizationStore,
  "findRepository" | "listRepositories"
>;

export interface GitHubLiveRepositoryClient {
  assertRepositoryRevision(input: {
    commitSha: string;
    fullName: string;
    installationId: number;
    providerRepositoryId: number;
  }): Promise<{ commitSha: string }>;
}

export class RepositoryAuthorizationError extends Error {
  constructor(
    readonly code: "INVALID_REVISION" | "REPOSITORY_NOT_FOUND",
  ) {
    super(
      code === "INVALID_REVISION"
        ? "The immutable repository revision is invalid"
        : "The repository is not available",
    );
    this.name = "RepositoryAuthorizationError";
  }
}

const principalSchema = z
  .object({
    callerId: z.string().min(1).max(128),
    principalId: z.string().min(1).max(128),
    tenantId: z.string().min(1).max(128),
  });
const listSchema = z
  .object({
    cursor: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
      .optional(),
    limit: z.number().int().min(1).max(100).default(50),
  })
  .strict();
const revisionSchema = z
  .object({
    commitSha: z.string().regex(/^[a-f0-9]{40}$/),
    repositoryId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  })
  .strict();

export class GitHubRepositoryProvider implements RepositorySourceProvider {
  constructor(
    private readonly catalog: Catalog,
    private readonly live: GitHubLiveRepositoryClient,
  ) {}

  async listAuthorizedRepositories(
    rawPrincipal: AuthorizedPrincipal,
    rawInput: { cursor?: string; limit?: number },
  ) {
    const principal = principalSchema.parse(rawPrincipal);
    const input = listSchema.parse(rawInput);
    const page = await this.catalog.listRepositories({
      ...input,
      tenantId: principal.tenantId,
    });
    return {
      nextCursor: page.nextCursor,
      repositories: page.repositories.map((repository) => ({
        defaultBranch: repository.defaultBranch,
        fullName: repository.fullName,
        private: repository.private,
        repositoryId: repository.repositoryId,
      })),
      tenantId: principal.tenantId,
    };
  }

  async resolveRevision(
    rawPrincipal: AuthorizedPrincipal,
    rawInput: { commitSha: string; repositoryId: string },
  ) {
    const principal = principalSchema.parse(rawPrincipal);
    const parsed = revisionSchema.safeParse(rawInput);
    if (!parsed.success) throw new RepositoryAuthorizationError("INVALID_REVISION");
    const repository = await this.catalog.findRepository(
      principal.tenantId,
      parsed.data.repositoryId,
    );
    if (!repository || repository.status !== "ACTIVE") {
      throw new RepositoryAuthorizationError("REPOSITORY_NOT_FOUND");
    }
    const revision = await this.live.assertRepositoryRevision({
      commitSha: parsed.data.commitSha,
      fullName: repository.fullName,
      installationId: repository.installationId,
      providerRepositoryId: repository.providerRepositoryId,
    });
    if (revision.commitSha !== parsed.data.commitSha) {
      throw new RepositoryAuthorizationError("INVALID_REVISION");
    }
    return {
      commitSha: revision.commitSha,
      defaultBranch: repository.defaultBranch,
      fullName: repository.fullName,
      private: repository.private,
      provider: "github" as const,
      repositoryId: repository.repositoryId,
    };
  }
}
