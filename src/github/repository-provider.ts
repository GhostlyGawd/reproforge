import { randomUUID } from "node:crypto";

import { z } from "zod";

import type { AuthorizedPrincipal } from "@/application/authorization";
import type { RepositorySourceProvider } from "@/application/ports/repository-source";
import type { GitHubAuthorizationStore } from "@/github/authorization-store";
import type { AuditSink } from "@/application/ports/production";

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
  private readonly audit?: AuditSink;
  private readonly clock: { now(): Date };
  private readonly eventId: () => string;

  constructor(
    private readonly catalog: Catalog,
    private readonly live: GitHubLiveRepositoryClient,
    options: {
      audit?: AuditSink;
      clock?: { now(): Date };
      eventId?: () => string;
    } = {},
  ) {
    this.audit = options.audit;
    this.clock = options.clock ?? { now: () => new Date() };
    this.eventId =
      options.eventId ??
      (() => `audit_repository_${randomUUID().replaceAll("-", "")}`);
  }

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
      await this.auditAccess(
        principal,
        parsed.data.repositoryId,
        "github.repository-access-denied",
        "denied",
        "unavailable",
      );
      throw new RepositoryAuthorizationError("REPOSITORY_NOT_FOUND");
    }
    let revision: { commitSha: string };
    try {
      revision = await this.live.assertRepositoryRevision({
        commitSha: parsed.data.commitSha,
        fullName: repository.fullName,
        installationId: repository.installationId,
        providerRepositoryId: repository.providerRepositoryId,
      });
    } catch (error) {
      await this.auditAccess(
        principal,
        repository.repositoryId,
        "github.repository-access-denied",
        "denied",
        "live-check-failed",
      );
      throw error;
    }
    if (revision.commitSha !== parsed.data.commitSha) {
      throw new RepositoryAuthorizationError("INVALID_REVISION");
    }
    await this.auditAccess(
      principal,
      repository.repositoryId,
      "github.repository-accessed",
      "success",
      "immutable-revision",
    );
    return {
      commitSha: revision.commitSha,
      defaultBranch: repository.defaultBranch,
      fullName: repository.fullName,
      private: repository.private,
      provider: "github" as const,
      repositoryId: repository.repositoryId,
    };
  }

  private async auditAccess(
    principal: Pick<AuthorizedPrincipal, "principalId" | "tenantId">,
    repositoryId: string,
    action:
      | "github.repository-access-denied"
      | "github.repository-accessed",
    outcome: "denied" | "success",
    reason: string,
  ): Promise<void> {
    await this.audit?.append({
      action,
      actorId: principal.principalId,
      eventId: this.eventId(),
      metadata: { provider: "github", reason },
      occurredAt: this.clock.now().toISOString(),
      outcome,
      targetId: repositoryId,
      targetType: "repository",
      tenantId: principal.tenantId,
    });
  }
}
