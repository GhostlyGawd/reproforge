import { createHash, randomUUID } from "node:crypto";

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
import type { GitHubWebhookEnvelope } from "@/github/webhook";
import {
  reduceGitHubAuthorizationState,
  type GitHubAuthorizationState,
  type GitHubAuthorizationStatus,
} from "@/github/authorization-state";
import {
  auditEventSchema,
  type AuditEvent,
} from "@/application/ports/production";
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
    providerUpdatedAt: timestamp.optional(),
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
const webhookInstallationSchema = z.object({
  action: z.string().min(1).max(64).regex(/^[a-z_]+$/),
  installation: z.object({
    id: z.number().int().positive().safe(),
    permissions: z.record(z.string(), z.string()),
    suspended_at: z.string().datetime({ offset: true }).nullable(),
    updated_at: z.string().datetime({ offset: true }),
  }),
});
const webhookRepositorySchema = z.object({
  action: z.enum(["added", "removed"]),
  installation: z.object({
    id: z.number().int().positive().safe(),
    updated_at: z.string().datetime({ offset: true }),
  }),
  repositories_added: z.array(
    z.object({
      default_branch: z.string().min(1).max(255).optional(),
      full_name: z.string().min(3).max(255).regex(/^[^/\s]+\/[^/\s]+$/).optional(),
      id: z.number().int().positive().safe(),
      private: z.boolean().optional(),
    }),
  ).max(10_000),
  repositories_removed: z.array(
    z.object({ id: z.number().int().positive().safe() }),
  ).max(10_000),
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
  private readonly auditEventId: () => string;
  private readonly clock: { now(): Date };

  constructor(
    private readonly database: PostgresDatabase,
    options: {
      auditEventId?: () => string;
      clock?: { now(): Date };
      repositoryId?: () => string;
    } = {},
  ) {
    this.repositoryId =
      options.repositoryId ?? (() => `repo_${randomUUID().replaceAll("-", "")}`);
    this.auditEventId =
      options.auditEventId ??
      (() => `audit_github_${randomUUID().replaceAll("-", "")}`);
    this.clock = options.clock ?? { now: () => new Date() };
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
    const occurredAt = this.clock.now().toISOString();
    await runSerializableTransaction(this.database, async (executor) => {
      await executor.query(
        `INSERT INTO github_installations (
           tenant_id, installation_id, linked_by_principal_id, account_id,
           account_login, repository_selection, permissions, status,
           provider_updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 'ACTIVE', $8)
         ON CONFLICT (tenant_id, installation_id) DO UPDATE SET
           linked_by_principal_id = EXCLUDED.linked_by_principal_id,
           account_id = EXCLUDED.account_id,
           account_login = EXCLUDED.account_login,
           repository_selection = EXCLUDED.repository_selection,
           permissions = EXCLUDED.permissions,
           provider_updated_at = EXCLUDED.provider_updated_at,
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
          installation.providerUpdatedAt ?? null,
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
      await this.appendAudit(executor, {
        action: "github.installation-linked",
        actorId: actor.principalId,
        eventId: this.auditEventId(),
        metadata: { selection: installation.repositorySelection },
        occurredAt,
        outcome: "success",
        targetId: String(installation.installationId),
        targetType: "installation",
        tenantId: actor.tenantId,
      });
    });
  }

  async processWebhook(
    rawEnvelope: GitHubWebhookEnvelope,
    rawOptions: { installation?: VerifiedGitHubInstallation } = {},
  ): Promise<"accepted" | "duplicate"> {
    const envelope = z
      .object({
        deliveryId: z.string().min(1).max(128).regex(/^[A-Za-z0-9-]+$/),
        event: z.enum(["installation", "installation_repositories"]),
        payload: z.unknown(),
      })
      .strict()
      .parse(rawEnvelope);
    const installation = rawOptions.installation
      ? installationSchema.parse({
          ...rawOptions.installation,
          repositories: rawOptions.installation.repositories ?? [],
        })
      : undefined;
    const receivedAt = this.clock.now().toISOString();
    const expiresAt = new Date(
      Date.parse(receivedAt) + 30 * 24 * 60 * 60_000,
    ).toISOString();
    const payloadHash = createHash("sha256")
      .update(JSON.stringify(envelope.payload))
      .digest("hex");
    return runSerializableTransaction(this.database, async (executor) => {
      const installationPayload =
        envelope.event === "installation"
          ? webhookInstallationSchema.safeParse(envelope.payload)
          : null;
      const repositoryPayload =
        envelope.event === "installation_repositories"
          ? webhookRepositorySchema.safeParse(envelope.payload)
          : null;
      const validPayload =
        installationPayload?.success === true ||
        repositoryPayload?.success === true;
      const installationId = installationPayload?.success
        ? installationPayload.data.installation.id
        : repositoryPayload?.success
          ? repositoryPayload.data.installation.id
          : null;
      const action = installationPayload?.success
        ? installationPayload.data.action
        : repositoryPayload?.success
          ? repositoryPayload.data.action
          : null;
      const inserted = await executor.query<{ delivery_id: string }>(
        `INSERT INTO github_webhook_deliveries (
           delivery_id, event, payload_hash, installation_id, action,
           received_at, expires_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (delivery_id) DO NOTHING
         RETURNING delivery_id`,
        [
          envelope.deliveryId,
          envelope.event,
          payloadHash,
          installationId,
          action,
          receivedAt,
          expiresAt,
        ],
      );
      if (!inserted.rows[0]) {
        if (repositoryPayload?.success && installation) {
          const owner = await executor.query<{ tenant_id: string }>(
            `SELECT tenant_id FROM github_installations
              WHERE installation_id = $1
              LIMIT 1`,
            [repositoryPayload.data.installation.id],
          );
          const tenantId = owner.rows[0]?.tenant_id;
          if (tenantId) {
            await this.applyRepositoryWebhook(
              executor,
              tenantId,
              repositoryPayload.data,
              receivedAt,
              installation,
            );
          }
        }
        return "duplicate";
      }
      if (!validPayload || installationId === null) {
        await this.completeDelivery(executor, envelope.deliveryId, receivedAt, null, "IGNORED");
        return "accepted";
      }
      const owner = await executor.query<{ tenant_id: string }>(
        `SELECT tenant_id FROM github_installations
          WHERE installation_id = $1
          LIMIT 1`,
        [installationId],
      );
      const tenantId = owner.rows[0]?.tenant_id;
      if (!tenantId) {
        await this.completeDelivery(executor, envelope.deliveryId, receivedAt, null, "IGNORED");
        return "accepted";
      }

      const audit = installationPayload?.success
        ? await this.applyInstallationWebhook(
            executor,
            tenantId,
            installationPayload.data,
            receivedAt,
          )
        : repositoryPayload?.success
          ? await this.applyRepositoryWebhook(
              executor,
              tenantId,
              repositoryPayload.data,
              receivedAt,
              installation,
            )
          : null;
      await this.completeDelivery(
        executor,
        envelope.deliveryId,
        receivedAt,
        tenantId,
        audit ? "ACCEPTED" : "IGNORED",
      );
      if (audit) await this.appendAudit(executor, audit);
      return "accepted";
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
    providerUpdatedAt?: string,
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
         full_name, default_branch, is_private, status, provider_updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'ACTIVE', $8)
       ON CONFLICT (tenant_id, installation_id, provider_repository_id)
       DO UPDATE SET
         full_name = EXCLUDED.full_name,
         default_branch = EXCLUDED.default_branch,
         is_private = EXCLUDED.is_private,
         status = 'ACTIVE', removed_at = NULL,
         provider_updated_at = COALESCE(
           EXCLUDED.provider_updated_at,
           github_repositories.provider_updated_at
         ),
         updated_at = CURRENT_TIMESTAMP`,
      [
        tenantId,
        repositoryId,
        installationId,
        repository.repositoryId,
        repository.fullName,
        repository.defaultBranch,
        repository.private,
        providerUpdatedAt ?? null,
      ],
    );
  }

  private async applyInstallationWebhook(
    executor: PostgresExecutor,
    tenantId: string,
    payload: z.infer<typeof webhookInstallationSchema>,
    at: string,
  ): Promise<AuditEvent | null> {
    const exactPermissions = permissionsSchema.safeParse(
      payload.installation.permissions,
    ).success;
    let desiredStatus: GitHubAuthorizationStatus;
    if (payload.action === "deleted") {
      desiredStatus = "REMOVED";
    } else if (payload.action === "suspended" || !exactPermissions) {
      desiredStatus = "SUSPENDED";
    } else if (
      payload.action === "unsuspended" ||
      payload.action === "new_permissions_accepted"
    ) {
      desiredStatus = "ACTIVE";
    } else {
      return null;
    }
    const existing = await executor.query<{
      provider_updated_at: string | Date | null;
      status: GitHubAuthorizationStatus;
    }>(
      `SELECT status, provider_updated_at
         FROM github_installations
        WHERE tenant_id = $1 AND installation_id = $2
        FOR UPDATE`,
      [tenantId, payload.installation.id],
    );
    const row = existing.rows[0];
    if (!row) return null;
    const current: GitHubAuthorizationState = {
      providerUpdatedAt:
        row.provider_updated_at === null ? null : toIso(row.provider_updated_at),
      status: row.status,
    };
    const next = reduceGitHubAuthorizationState(current, {
      at: payload.installation.updated_at,
      status: desiredStatus,
    });
    if (
      next.status === current.status &&
      next.providerUpdatedAt === current.providerUpdatedAt
    ) {
      return null;
    }
    await executor.query(
      `UPDATE github_installations
          SET status = $3,
              suspended_at = CASE
                WHEN $3 = 'SUSPENDED' THEN $4::timestamptz ELSE NULL
              END,
              removed_at = CASE
                WHEN $3 = 'REMOVED' THEN $4::timestamptz ELSE NULL
              END,
              updated_at = $4::timestamptz,
              provider_updated_at = $5::timestamptz
        WHERE tenant_id = $1 AND installation_id = $2`,
      [tenantId, payload.installation.id, next.status, at, next.providerUpdatedAt],
    );
    if (next.status === "REMOVED") {
      await executor.query(
        `UPDATE github_repositories
            SET status = 'REMOVED', removed_at = $3, updated_at = $3
          WHERE tenant_id = $1 AND installation_id = $2
            AND status <> 'REMOVED'`,
        [tenantId, payload.installation.id, at],
      );
    }
    const action =
      next.status === "REMOVED"
        ? "github.installation-removed"
        : next.status === "SUSPENDED"
          ? "github.installation-suspended"
          : "github.installation-activated";
    return {
      action,
      actorId: "github-webhook",
      eventId: this.auditEventId(),
      metadata: {
        permissionsExact: exactPermissions,
        provider: "github",
      },
      occurredAt: at,
      outcome: "success",
      targetId: String(payload.installation.id),
      targetType: "installation",
      tenantId,
    };
  }

  private async applyRepositoryWebhook(
    executor: PostgresExecutor,
    tenantId: string,
    payload: z.infer<typeof webhookRepositorySchema>,
    at: string,
    installation?: z.infer<typeof installationSchema>,
  ): Promise<AuditEvent> {
    if (installation) {
      if (installation.installationId !== payload.installation.id) {
        throw new Error("GitHub installation snapshot does not match webhook");
      }
      await executor.query(
        `UPDATE github_installations
            SET account_id = $3,
                account_login = $4,
                repository_selection = $5,
                permissions = $6::jsonb,
                provider_updated_at = COALESCE($7::timestamptz, provider_updated_at),
                updated_at = $8::timestamptz
          WHERE tenant_id = $1 AND installation_id = $2`,
        [
          tenantId,
          installation.installationId,
          installation.accountId,
          installation.accountLogin,
          installation.repositorySelection,
          JSON.stringify(installation.permissions),
          installation.providerUpdatedAt ?? null,
          at,
        ],
      );
      await executor.query(
        `UPDATE github_repositories
            SET status = 'REMOVED', removed_at = $3::timestamptz,
                updated_at = $3::timestamptz
          WHERE tenant_id = $1 AND installation_id = $2
            AND status = 'ACTIVE'`,
        [tenantId, installation.installationId, at],
      );
      for (const repository of installation.repositories) {
        await this.upsertRepository(
          executor,
          tenantId,
          installation.installationId,
          repository,
          installation.providerUpdatedAt,
        );
      }
    } else {
    for (const repository of payload.repositories_removed) {
      await this.applyRepositoryTransition(executor, {
        at,
        installationId: payload.installation.id,
        providerRepositoryId: repository.id,
        providerUpdatedAt: payload.installation.updated_at,
        status: "REMOVED",
        tenantId,
      });
    }
    for (const repository of payload.repositories_added) {
      if (
        repository.default_branch &&
        repository.full_name &&
        repository.private !== undefined
      ) {
        await this.applyRepositoryTransition(
          executor,
          {
            at,
            installationId: payload.installation.id,
            providerRepositoryId: repository.id,
            providerUpdatedAt: payload.installation.updated_at,
            status: "ACTIVE",
            tenantId,
          },
          {
            defaultBranch: repository.default_branch,
            fullName: repository.full_name,
            private: repository.private,
            repositoryId: repository.id,
          },
        );
      }
    }
    }
    return {
      action: "github.repositories-updated",
      actorId: "github-webhook",
      eventId: this.auditEventId(),
      metadata: {
        added: payload.repositories_added.length,
        provider: "github",
        reconciled: installation !== undefined,
        removed: payload.repositories_removed.length,
      },
      occurredAt: at,
      outcome: "success",
      targetId: String(payload.installation.id),
      targetType: "installation",
      tenantId,
    };
  }

  private async applyRepositoryTransition(
    executor: PostgresExecutor,
    input: {
      at: string;
      installationId: number;
      providerRepositoryId: number;
      providerUpdatedAt: string;
      status: "ACTIVE" | "REMOVED";
      tenantId: string;
    },
    repository?: z.infer<typeof repositorySchema>,
  ): Promise<void> {
    const existing = await executor.query<{
      provider_updated_at: string | Date | null;
      repository_id: string;
      status: "ACTIVE" | "REMOVED";
    }>(
      `SELECT repository_id, status, provider_updated_at
         FROM github_repositories
        WHERE tenant_id = $1 AND installation_id = $2
          AND provider_repository_id = $3
        FOR UPDATE`,
      [input.tenantId, input.installationId, input.providerRepositoryId],
    );
    const row = existing.rows[0];
    if (!row) {
      if (input.status === "ACTIVE" && repository) {
        const repositoryId = opaqueId.parse(this.repositoryId());
        await executor.query(
          `INSERT INTO github_repositories (
             tenant_id, repository_id, installation_id, provider_repository_id,
             full_name, default_branch, is_private, status, provider_updated_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'ACTIVE', $8)`,
          [
            input.tenantId,
            repositoryId,
            input.installationId,
            input.providerRepositoryId,
            repository.fullName,
            repository.defaultBranch,
            repository.private,
            input.providerUpdatedAt,
          ],
        );
      }
      return;
    }
    const current: GitHubAuthorizationState = {
      providerUpdatedAt:
        row.provider_updated_at === null ? null : toIso(row.provider_updated_at),
      status: row.status,
    };
    const next = reduceGitHubAuthorizationState(current, {
      at: input.providerUpdatedAt,
      status: input.status,
    });
    if (
      next.status === current.status &&
      next.providerUpdatedAt === current.providerUpdatedAt
    ) {
      return;
    }
    await executor.query(
      `UPDATE github_repositories
          SET status = $4,
              removed_at = CASE
                WHEN $4 = 'REMOVED' THEN $5::timestamptz ELSE NULL
              END,
              full_name = COALESCE($6, full_name),
              default_branch = COALESCE($7, default_branch),
              is_private = COALESCE($8, is_private),
              provider_updated_at = $9::timestamptz,
              updated_at = $5::timestamptz
        WHERE tenant_id = $1 AND installation_id = $2
          AND provider_repository_id = $3`,
      [
        input.tenantId,
        input.installationId,
        input.providerRepositoryId,
        next.status,
        input.at,
        repository?.fullName ?? null,
        repository?.defaultBranch ?? null,
        repository?.private ?? null,
        next.providerUpdatedAt,
      ],
    );
  }

  private async completeDelivery(
    executor: PostgresExecutor,
    deliveryId: string,
    at: string,
    tenantId: string | null,
    outcome: "ACCEPTED" | "IGNORED",
  ): Promise<void> {
    await executor.query(
      `UPDATE github_webhook_deliveries
          SET tenant_id = $2, outcome = $3, processed_at = $4
        WHERE delivery_id = $1 AND outcome = 'PROCESSING'`,
      [deliveryId, tenantId, outcome, at],
    );
  }

  private async appendAudit(
    executor: PostgresExecutor,
    rawEvent: AuditEvent,
  ): Promise<void> {
    const event = auditEventSchema.parse(rawEvent);
    await executor.query(
      `INSERT INTO audit_events (
         tenant_id, id, actor_id, action, target_type, target_id,
         outcome, metadata, occurred_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
      [
        event.tenantId,
        event.eventId,
        event.actorId,
        event.action,
        event.targetType,
        event.targetId,
        event.outcome,
        JSON.stringify(event.metadata),
        event.occurredAt,
      ],
    );
  }
}
