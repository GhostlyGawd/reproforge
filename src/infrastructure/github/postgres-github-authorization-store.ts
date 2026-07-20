import { randomUUID } from "node:crypto";

import { z } from "zod";

import type { VerifiedGitHubInstallation } from "@/github/callback";
import type {
  GitHubAuthorizationStore,
  GitHubRepositoryAuthorization,
  GitHubRepositoryPage,
} from "@/github/authorization-store";
import type {
  GitHubInstallationActor,
  GitHubInstallationStateRecord,
} from "@/github/installation-state";
import {
  runSerializableTransaction,
  type PostgresDatabase,
  type PostgresExecutor,
} from "@/infrastructure/postgres/database";

const opaqueId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const timestamp = z.string().datetime({ offset: true });
const actorSchema = z
  .object({ principalId: opaqueId, tenantId: opaqueId })
  .strict();
const stateSchema = actorSchema
  .extend({
    consumedAt: timestamp.nullable(),
    createdAt: timestamp,
    expiresAt: timestamp,
    stateHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const permissionsSchema = z
  .object({
    contents: z.literal("read"),
    issues: z.literal("read"),
    metadata: z.literal("read"),
  })
  .strict();
const repositorySchema = z
  .object({
    defaultBranch: z.string().min(1).max(255).regex(/^[^\u0000-\u001f\u007f]+$/),
    fullName: z.string().min(3).max(255).regex(/^[^/\s]+\/[^/\s]+$/),
    private: z.boolean(),
    repositoryId: z.number().int().positive().safe(),
  })
  .strict();
const installationSchema = z
  .object({
    accountId: z.number().int().positive().safe(),
    accountLogin: z
      .string()
      .min(1)
      .max(39)
      .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/),
    installationId: z.number().int().positive().safe(),
    permissions: permissionsSchema,
    repositories: z.array(repositorySchema).max(10_000).default([]),
    repositorySelection: z.enum(["all", "selected"]),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = value.repositories.map(({ repositoryId }) => repositoryId);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: "custom", message: "Duplicate repository" });
    }
  });

type RepositoryRow = {
  default_branch: string;
  full_name: string;
  installation_id: string | number;
  is_private: boolean;
  permissions: unknown;
  provider_repository_id: string | number;
  repository_id: string;
  status: string;
  tenant_id: string;
};

function toIso(value: string | Date): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function integer(value: string | number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error("Invalid GitHub authorization metadata");
  }
  return parsed;
}

function parsePermissions(value: unknown) {
  const candidate =
    typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  return permissionsSchema.parse(candidate);
}

function repositoryFromRow(row: RepositoryRow): GitHubRepositoryAuthorization {
  const status = z.enum(["ACTIVE", "REMOVED", "SUSPENDED"]).parse(row.status);
  return {
    defaultBranch: row.default_branch,
    fullName: row.full_name,
    installationId: integer(row.installation_id),
    permissions: parsePermissions(row.permissions),
    private: row.is_private,
    providerRepositoryId: integer(row.provider_repository_id),
    repositoryId: opaqueId.parse(row.repository_id),
    status,
    tenantId: opaqueId.parse(row.tenant_id),
  };
}

const SELECT_REPOSITORY = `
  SELECT r.tenant_id, r.repository_id, r.installation_id::text,
         r.provider_repository_id::text, r.full_name, r.default_branch,
         r.is_private, i.permissions,
         CASE
           WHEN i.status = 'SUSPENDED' THEN 'SUSPENDED'
           WHEN i.status = 'REMOVED' OR r.status = 'REMOVED' THEN 'REMOVED'
           ELSE 'ACTIVE'
         END AS status
    FROM github_repositories r
    JOIN github_installations i
      ON i.tenant_id = r.tenant_id
     AND i.installation_id = r.installation_id`;

export class PostgresGitHubAuthorizationStore
  implements GitHubAuthorizationStore
{
  private readonly repositoryId: () => string;

  constructor(
    private readonly database: PostgresDatabase,
    options: { repositoryId?: () => string } = {},
  ) {
    this.repositoryId =
      options.repositoryId ?? (() => `repo_${randomUUID().replaceAll("-", "")}`);
  }

  async create(rawRecord: GitHubInstallationStateRecord): Promise<void> {
    const record = stateSchema.parse(rawRecord);
    await this.database.query(
      `INSERT INTO github_installation_states (
         state_hash, tenant_id, principal_id, created_at, expires_at, consumed_at
       ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        record.stateHash,
        record.tenantId,
        record.principalId,
        record.createdAt,
        record.expiresAt,
        record.consumedAt,
      ],
    );
  }

  async consume(
    rawInput: GitHubInstallationActor & { at: string; stateHash: string },
  ): Promise<GitHubInstallationStateRecord | null> {
    const input = actorSchema
      .extend({ at: timestamp, stateHash: z.string().regex(/^[a-f0-9]{64}$/) })
      .strict()
      .parse(rawInput);
    const result = await this.database.query<{
      consumed_at: string | Date;
      created_at: string | Date;
      expires_at: string | Date;
      principal_id: string;
      state_hash: string;
      tenant_id: string;
    }>(
      `UPDATE github_installation_states
          SET consumed_at = $4
        WHERE state_hash = $1 AND tenant_id = $2 AND principal_id = $3
          AND consumed_at IS NULL AND expires_at >= $4
        RETURNING state_hash, tenant_id, principal_id,
                  created_at, expires_at, consumed_at`,
      [input.stateHash, input.tenantId, input.principalId, input.at],
    );
    const row = result.rows[0];
    return row
      ? {
          consumedAt: toIso(row.consumed_at),
          createdAt: toIso(row.created_at),
          expiresAt: toIso(row.expires_at),
          principalId: row.principal_id,
          stateHash: row.state_hash,
          tenantId: row.tenant_id,
        }
      : null;
  }

  async bind(
    rawActor: GitHubInstallationActor,
    rawInstallation: VerifiedGitHubInstallation,
  ): Promise<void> {
    const actor = actorSchema.parse(rawActor);
    const installation = installationSchema.parse({
      ...rawInstallation,
      repositories: rawInstallation.repositories ?? [],
    });
    await runSerializableTransaction(this.database, async (executor) => {
      await executor.query(
        `INSERT INTO github_installations (
           tenant_id, installation_id, linked_by_principal_id, account_id,
           account_login, repository_selection, permissions, status
         ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 'ACTIVE')
         ON CONFLICT (tenant_id, installation_id) DO UPDATE SET
           linked_by_principal_id = EXCLUDED.linked_by_principal_id,
           account_id = EXCLUDED.account_id,
           account_login = EXCLUDED.account_login,
           repository_selection = EXCLUDED.repository_selection,
           permissions = EXCLUDED.permissions,
           status = 'ACTIVE', suspended_at = NULL, removed_at = NULL,
           updated_at = CURRENT_TIMESTAMP`,
        [
          actor.tenantId,
          installation.installationId,
          actor.principalId,
          installation.accountId,
          installation.accountLogin,
          installation.repositorySelection,
          JSON.stringify(installation.permissions),
        ],
      );
      await executor.query(
        `UPDATE github_repositories
            SET status = 'REMOVED', removed_at = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP
          WHERE tenant_id = $1 AND installation_id = $2
            AND status = 'ACTIVE'`,
        [actor.tenantId, installation.installationId],
      );
      for (const repository of installation.repositories) {
        await this.upsertRepository(executor, actor.tenantId, installation.installationId, repository);
      }
    });
  }

  async findRepository(
    rawTenantId: string,
    rawRepositoryId: string,
  ): Promise<GitHubRepositoryAuthorization | null> {
    const tenantId = opaqueId.parse(rawTenantId);
    const repositoryId = opaqueId.parse(rawRepositoryId);
    const result = await this.database.query<RepositoryRow>(
      `${SELECT_REPOSITORY}
        WHERE r.tenant_id = $1 AND r.repository_id = $2
        LIMIT 1`,
      [tenantId, repositoryId],
    );
    return result.rows[0] ? repositoryFromRow(result.rows[0]) : null;
  }

  async listRepositories(rawInput: {
    cursor?: string;
    limit: number;
    tenantId: string;
  }): Promise<GitHubRepositoryPage> {
    const input = z
      .object({
        cursor: opaqueId.optional(),
        limit: z.number().int().min(1).max(100),
        tenantId: opaqueId,
      })
      .strict()
      .parse(rawInput);
    const result = await this.database.query<RepositoryRow>(
      `${SELECT_REPOSITORY}
        WHERE r.tenant_id = $1
          AND r.status = 'ACTIVE' AND i.status = 'ACTIVE'
          AND ($2::text IS NULL OR r.repository_id > $2)
        ORDER BY r.repository_id
        LIMIT $3`,
      [input.tenantId, input.cursor ?? null, input.limit + 1],
    );
    const page = result.rows.slice(0, input.limit).map(repositoryFromRow);
    return {
      nextCursor:
        result.rows.length > input.limit
          ? (page.at(-1)?.repositoryId ?? null)
          : null,
      repositories: page,
    };
  }

  private async upsertRepository(
    executor: PostgresExecutor,
    tenantId: string,
    installationId: number,
    repository: z.infer<typeof repositorySchema>,
  ): Promise<void> {
    const existing = await executor.query<{ repository_id: string }>(
      `SELECT repository_id
         FROM github_repositories
        WHERE tenant_id = $1 AND installation_id = $2
          AND provider_repository_id = $3`,
      [tenantId, installationId, repository.repositoryId],
    );
    const repositoryId = opaqueId.parse(
      existing.rows[0]?.repository_id ?? this.repositoryId(),
    );
    await executor.query(
      `INSERT INTO github_repositories (
         tenant_id, repository_id, installation_id, provider_repository_id,
         full_name, default_branch, is_private, status
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'ACTIVE')
       ON CONFLICT (tenant_id, installation_id, provider_repository_id)
       DO UPDATE SET
         full_name = EXCLUDED.full_name,
         default_branch = EXCLUDED.default_branch,
         is_private = EXCLUDED.is_private,
         status = 'ACTIVE', removed_at = NULL,
         updated_at = CURRENT_TIMESTAMP`,
      [
        tenantId,
        repositoryId,
        installationId,
        repository.repositoryId,
        repository.fullName,
        repository.defaultBranch,
        repository.private,
      ],
    );
  }
}
