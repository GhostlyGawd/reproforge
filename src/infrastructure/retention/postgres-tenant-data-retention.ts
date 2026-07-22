import { createHash, randomUUID } from "node:crypto";

import { tenantScopeSchema, type TenantScope } from "@/application/ports/production";
import type { PrivateBlobClient } from "@/infrastructure/artifacts/private-blob-client";
import {
  runSerializableTransaction,
  type PostgresDatabase,
  type PostgresExecutor,
} from "@/infrastructure/postgres/database";
import { PostgresDurableReproductionRepository } from "@/infrastructure/postgres/repositories";

type ArtifactRow = Readonly<{
  object_key: string;
  provider_etag: string | null;
  status: string;
}>;

type DeletionClaim = Readonly<{
  artifacts: ArtifactRow[];
  claimExpiresAt: string;
  claimOwner: string;
  requestedBy: string;
  requestId: string;
  tenantId: string;
  version: number;
}>;

export type RetentionClassResults = Readonly<{
  artifacts: number;
  auditEvents: number;
  cases: number;
  deletionRequests: number;
  githubInstallationStates: number;
  githubInstallations: number;
  githubRepositories: number;
  githubWebhookDeliveries: number;
  idempotencyKeys: number;
  jobs: number;
  outboxEvents: number;
  principals: number;
  quotaEntries: number;
  runEvidence: number;
}>;

export type RetentionDeletionResult = Readonly<{
  classResults: RetentionClassResults;
  requestId: string;
  tenantId: string;
  tombstoneId: string;
}>;

export class RetentionDeletionError extends Error {
  constructor(
    readonly code:
      | "RETENTION_ARTIFACT_NOT_SETTLED"
      | "RETENTION_PROVIDER_FAILURE",
  ) {
    super("Tenant retention deletion could not safely complete");
    this.name = "RetentionDeletionError";
  }
}

function canonicalTimestamp(value: string): string | null {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value
    ? null
    : parsed.toISOString();
}

function integer(value: string | number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error("Corrupt deletion state");
  return parsed;
}

function lifecycleId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${createHash("sha256")
    .update(parts.join(":"))
    .digest("hex")
    .slice(0, 40)}`;
}

function retentionUntil(at: string): string {
  const date = new Date(at);
  date.setUTCFullYear(date.getUTCFullYear() + 1);
  return date.toISOString();
}

function validId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

async function appendRequestAudit(
  executor: PostgresExecutor,
  input: {
    actorId: string;
    at: string;
    reason: "retention" | "user-request";
    requestId: string;
    tenantId: string;
  },
): Promise<void> {
  await executor.query(
    `INSERT INTO audit_events (
       tenant_id, id, actor_id, action, target_type, target_id,
       outcome, metadata, occurred_at, retention_until
     ) VALUES ($1, $2, $3, 'account.deletion-requested', 'account', $1,
               'success', $4::jsonb, $5, $6)
     ON CONFLICT (tenant_id, id) DO NOTHING`,
    [
      input.tenantId,
      lifecycleId("audit_delete_request", input.tenantId, input.requestId),
      input.actorId,
      JSON.stringify({ reason: input.reason }),
      input.at,
      retentionUntil(input.at),
    ],
  );
}

async function suspendAndCancelTenant(
  executor: PostgresExecutor,
  input: { actorId: string; at: string; tenantId: string },
): Promise<void> {
  const activeJobs = await executor.query<{
    caller_id: string;
    id: string;
  }>(
    `SELECT DISTINCT i.caller_id, j.id
       FROM jobs j
       JOIN idempotency_keys i
         ON i.tenant_id = j.tenant_id AND i.job_id = j.id
      WHERE j.tenant_id = $1 AND j.state IN ('QUEUED', 'RUNNING')
      ORDER BY j.id, i.caller_id`,
    [input.tenantId],
  );
  const repository = new PostgresDurableReproductionRepository(executor);
  for (const job of activeJobs.rows) {
    await repository.requestCancellation(
      {
        callerId: job.caller_id,
        principalId: input.actorId,
        tenantId: input.tenantId,
      },
      job.id,
      input.at,
    );
  }
  await executor.query(
    `UPDATE tenants
        SET status = 'SUSPENDED', updated_at = $2
      WHERE id = $1 AND status = 'ACTIVE'`,
    [input.tenantId, input.at],
  );
}

export class PostgresTenantDataRetention {
  constructor(
    private readonly database: PostgresDatabase,
    private readonly blobs: PrivateBlobClient,
  ) {}

  async request(input: {
    at: string;
    requestId: string;
    scheduledAt: string;
    scope: TenantScope;
  }): Promise<{ created: boolean; requestId: string }> {
    const scope = tenantScopeSchema.parse(input.scope);
    const at = canonicalTimestamp(input.at);
    const scheduledAt = canonicalTimestamp(input.scheduledAt);
    if (
      !at ||
      !scheduledAt ||
      Date.parse(scheduledAt) < Date.parse(at) ||
      !validId(input.requestId)
    ) {
      throw new Error("Invalid tenant deletion request");
    }
    return runSerializableTransaction(this.database, async (executor) => {
      const tenant = await executor.query<{ status: string }>(
        "SELECT status FROM tenants WHERE id = $1 FOR UPDATE",
        [scope.tenantId],
      );
      if (!tenant.rows[0] || tenant.rows[0].status === "DELETED") {
        return { created: false, requestId: input.requestId };
      }
      const existing = await executor.query<{ id: string }>(
        `SELECT id FROM deletion_requests
          WHERE tenant_id = $1 AND id = $2 AND requested_by = $3`,
        [scope.tenantId, input.requestId, scope.principalId],
      );
      if (existing.rows[0]) {
        return { created: false, requestId: input.requestId };
      }
      const inserted = await executor.query<{ id: string }>(
        `INSERT INTO deletion_requests (
           tenant_id, id, requested_by, state, scheduled_at,
           created_at, updated_at, retention_until
         ) VALUES ($1, $2, $3, 'SCHEDULED', $4, $5, $5, $6)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [
          scope.tenantId,
          input.requestId,
          scope.principalId,
          scheduledAt,
          at,
          retentionUntil(at),
        ],
      );
      if (!inserted.rows[0]) {
        return { created: false, requestId: input.requestId };
      }
      await appendRequestAudit(executor, {
        actorId: scope.principalId,
        at,
        reason: "user-request",
        requestId: input.requestId,
        tenantId: scope.tenantId,
      });
      await suspendAndCancelTenant(executor, {
        actorId: scope.principalId,
        at,
        tenantId: scope.tenantId,
      });
      return { created: true, requestId: input.requestId };
    });
  }

  async scheduleDue(input: { at: string; limit: number }): Promise<string[]> {
    const at = canonicalTimestamp(input.at);
    if (!at || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > 1_000) {
      throw new Error("Invalid retention schedule request");
    }
    return runSerializableTransaction(this.database, async (executor) => {
      const due = await executor.query<{
        id: string;
        retention_until: Date | string;
      }>(
        `SELECT t.id, t.retention_until
           FROM tenants t
          WHERE t.status = 'ACTIVE' AND t.retention_until <= $1
            AND NOT EXISTS (
              SELECT 1 FROM deletion_requests d
               WHERE d.tenant_id = t.id
                 AND d.state IN ('REQUESTED', 'SCHEDULED', 'RUNNING')
            )
          ORDER BY t.retention_until, t.id
          FOR UPDATE SKIP LOCKED
          LIMIT $2`,
        [at, input.limit],
      );
      const scheduled: string[] = [];
      for (const tenant of due.rows) {
        const requestId = lifecycleId(
          "retention",
          tenant.id,
          at,
          new Date(tenant.retention_until).toISOString(),
        );
        const inserted = await executor.query<{ id: string }>(
          `INSERT INTO deletion_requests (
             tenant_id, id, requested_by, state, scheduled_at,
             created_at, updated_at, retention_until
           ) VALUES ($1, $2, 'system_retention', 'SCHEDULED', $3, $3, $3, $4)
           ON CONFLICT DO NOTHING
           RETURNING id`,
          [tenant.id, requestId, at, retentionUntil(at)],
        );
        if (!inserted.rows[0]) continue;
        await appendRequestAudit(executor, {
          actorId: "system_retention",
          at,
          reason: "retention",
          requestId,
          tenantId: tenant.id,
        });
        await suspendAndCancelTenant(executor, {
          actorId: "system_retention",
          at,
          tenantId: tenant.id,
        });
        scheduled.push(requestId);
      }
      return scheduled;
    });
  }

  async executeNext(input: {
    at: string;
    ownerId?: string;
  }): Promise<RetentionDeletionResult | null> {
    const at = canonicalTimestamp(input.at);
    const ownerId = input.ownerId ?? `retention_${randomUUID()}`;
    if (!at || !validId(ownerId)) {
      throw new Error("Invalid retention execution request");
    }
    const claim = await this.claimNext(at, ownerId);
    if (!claim) return null;

    let failureCode: RetentionDeletionError["code"] | null = null;
    try {
      for (const artifact of claim.artifacts) {
        if (artifact.status === "PENDING" || artifact.status === "DELETING") {
          failureCode = "RETENTION_ARTIFACT_NOT_SETTLED";
          throw new RetentionDeletionError(failureCode);
        }
        const deleted = await this.blobs.delete(
          artifact.object_key,
          artifact.provider_etag ?? undefined,
        );
        if (!deleted && (await this.blobs.head(artifact.object_key)) !== null) {
          failureCode = "RETENTION_PROVIDER_FAILURE";
          throw new RetentionDeletionError(failureCode);
        }
      }
    } catch (error) {
      const failure =
        error instanceof RetentionDeletionError
          ? error
          : new RetentionDeletionError(
              failureCode ?? "RETENTION_PROVIDER_FAILURE",
            );
      await this.markFailed(claim, at, failure.code);
      throw failure;
    }
    return this.complete(claim, at);
  }

  private async claimNext(
    at: string,
    ownerId: string,
  ): Promise<DeletionClaim | null> {
    return runSerializableTransaction(this.database, async (executor) => {
      const selected = await executor.query<{
        id: string;
        requested_by: string;
        tenant_id: string;
        version: number | string;
      }>(
        `SELECT d.tenant_id, d.id, d.requested_by, d.version
           FROM deletion_requests d
           JOIN tenants t ON t.id = d.tenant_id
          WHERE (
              (
                d.state IN ('REQUESTED', 'SCHEDULED')
                AND coalesce(d.scheduled_at, d.created_at) <= $1
                AND t.status IN ('ACTIVE', 'SUSPENDED')
              ) OR (
                d.state = 'RUNNING' AND d.claim_expires_at <= $1
                AND t.status = 'DELETING'
              )
            )
            AND NOT EXISTS (
              SELECT 1 FROM jobs j
               WHERE j.tenant_id = d.tenant_id AND j.state = 'RUNNING'
            )
          ORDER BY coalesce(d.scheduled_at, d.created_at), d.created_at,
                   d.tenant_id, d.id
          FOR UPDATE OF d, t SKIP LOCKED
          LIMIT 1`,
        [at],
      );
      const row = selected.rows[0];
      if (!row) return null;
      const claimExpiresAt = new Date(Date.parse(at) + 300_000).toISOString();
      const claimed = await executor.query<{ version: number | string }>(
        `UPDATE deletion_requests
            SET state = 'RUNNING', claim_owner = $4, claim_expires_at = $5,
                updated_at = $6, version = version + 1
          WHERE tenant_id = $1 AND id = $2 AND version = $3
            AND (
              state IN ('REQUESTED', 'SCHEDULED')
              OR (state = 'RUNNING' AND claim_expires_at <= $6)
            )
          RETURNING version`,
        [row.tenant_id, row.id, row.version, ownerId, claimExpiresAt, at],
      );
      const version = integer(claimed.rows[0]?.version ?? 0);
      if (version !== integer(row.version) + 1) return null;
      await executor.query(
        `UPDATE tenants
            SET status = 'DELETING', updated_at = $2
          WHERE id = $1 AND status IN ('ACTIVE', 'SUSPENDED')`,
        [row.tenant_id, at],
      );
      const artifacts = await executor.query<ArtifactRow>(
        `SELECT object_key, provider_etag, status
           FROM artifacts
          WHERE tenant_id = $1
          ORDER BY object_key`,
        [row.tenant_id],
      );
      return {
        artifacts: artifacts.rows,
        claimExpiresAt,
        claimOwner: ownerId,
        requestedBy: row.requested_by,
        requestId: row.id,
        tenantId: row.tenant_id,
        version,
      };
    });
  }

  private async markFailed(
    claim: DeletionClaim,
    at: string,
    failureCode: RetentionDeletionError["code"],
  ): Promise<void> {
    await runSerializableTransaction(this.database, async (executor) => {
      const failed = await executor.query<{ id: string }>(
        `UPDATE deletion_requests
            SET state = 'FAILED', failure_code = $4,
                claim_owner = NULL, claim_expires_at = NULL,
                updated_at = $5, version = version + 1
          WHERE tenant_id = $1 AND id = $2 AND version = $3
            AND state = 'RUNNING'
            AND claim_owner = $6 AND claim_expires_at = $7
          RETURNING id`,
        [
          claim.tenantId,
          claim.requestId,
          claim.version,
          failureCode,
          at,
          claim.claimOwner,
          claim.claimExpiresAt,
        ],
      );
      if (!failed.rows[0]) throw new Error("Lost retention deletion claim");
      await executor.query(
        `UPDATE tenants SET status = $3, updated_at = $2
          WHERE id = $1 AND status = 'DELETING'`,
        [claim.tenantId, at, "SUSPENDED"],
      );
    });
  }

  private async complete(
    claim: DeletionClaim,
    at: string,
  ): Promise<RetentionDeletionResult> {
    return runSerializableTransaction(this.database, async (executor) => {
      const owned = await executor.query<{ found: boolean }>(
        `SELECT true AS found
           FROM deletion_requests d
           JOIN tenants t ON t.id = d.tenant_id
          WHERE d.tenant_id = $1 AND d.id = $2 AND d.version = $3
            AND d.state = 'RUNNING' AND t.status = 'DELETING'
            AND d.claim_owner = $4 AND d.claim_expires_at = $5
          FOR UPDATE OF d, t`,
        [
          claim.tenantId,
          claim.requestId,
          claim.version,
          claim.claimOwner,
          claim.claimExpiresAt,
        ],
      );
      if (!owned.rows[0]?.found) throw new Error("Lost retention deletion claim");

      const classResults = await this.countClasses(executor, claim.tenantId);
      await executor.query("DELETE FROM run_evidence WHERE tenant_id = $1", [claim.tenantId]);
      await executor.query("DELETE FROM idempotency_keys WHERE tenant_id = $1", [claim.tenantId]);
      await executor.query("DELETE FROM outbox_events WHERE tenant_id = $1", [claim.tenantId]);
      await executor.query("DELETE FROM quota_ledger WHERE tenant_id = $1", [claim.tenantId]);
      await executor.query("DELETE FROM artifacts WHERE tenant_id = $1", [claim.tenantId]);
      await executor.query("DELETE FROM jobs WHERE tenant_id = $1", [claim.tenantId]);
      await executor.query("DELETE FROM cases WHERE tenant_id = $1", [claim.tenantId]);
      await executor.query(
        "DELETE FROM github_webhook_deliveries WHERE tenant_id = $1",
        [claim.tenantId],
      );
      await executor.query(
        "DELETE FROM github_installation_states WHERE tenant_id = $1",
        [claim.tenantId],
      );
      await executor.query(
        "DELETE FROM github_installations WHERE tenant_id = $1",
        [claim.tenantId],
      );
      await executor.query("DELETE FROM principals WHERE tenant_id = $1", [claim.tenantId]);
      await executor.query("DELETE FROM audit_events WHERE tenant_id = $1", [claim.tenantId]);

      const tombstoneId = lifecycleId(
        "audit_tombstone",
        claim.tenantId,
        claim.requestId,
      );
      await executor.query(
        `INSERT INTO audit_events (
           tenant_id, id, actor_id, action, target_type, target_id,
           outcome, metadata, occurred_at, retention_until
         ) VALUES ($1, $2, 'system_retention', 'account.deleted', 'account', $1,
                   'success', $3::jsonb, $4, $5)`,
        [
          claim.tenantId,
          tombstoneId,
          JSON.stringify({
            reason:
              claim.requestedBy === "system_retention"
                ? "retention"
                : "user-request",
          }),
          at,
          retentionUntil(at),
        ],
      );
      const completed = await executor.query<{ id: string }>(
        `UPDATE deletion_requests
            SET state = 'COMPLETED', completed_at = $4,
                class_results = $5::jsonb, audit_tombstone_id = $6,
                claim_owner = NULL, claim_expires_at = NULL,
                updated_at = $4, version = version + 1
          WHERE tenant_id = $1 AND id = $2 AND version = $3
            AND state = 'RUNNING'
            AND claim_owner = $7 AND claim_expires_at = $8
          RETURNING id`,
        [
          claim.tenantId,
          claim.requestId,
          claim.version,
          at,
          JSON.stringify(classResults),
          tombstoneId,
          claim.claimOwner,
          claim.claimExpiresAt,
        ],
      );
      if (!completed.rows[0]) throw new Error("Lost retention deletion claim");
      await executor.query(
        "DELETE FROM deletion_requests WHERE tenant_id = $1 AND id = $2",
        [claim.tenantId, claim.requestId],
      );
      await executor.query(
        `UPDATE tenants
            SET status = 'DELETED', deleted_at = $2,
                retention_until = NULL, updated_at = $2
          WHERE id = $1 AND status = 'DELETING'`,
        [claim.tenantId, at],
      );
      return {
        classResults,
        requestId: claim.requestId,
        tenantId: claim.tenantId,
        tombstoneId,
      };
    });
  }

  private async countClasses(
    executor: PostgresExecutor,
    tenantId: string,
  ): Promise<RetentionClassResults> {
    const result = await executor.query<Record<string, number | string>>(
      `SELECT
         (SELECT count(*) FROM artifacts WHERE tenant_id = $1) AS artifacts,
         (SELECT count(*) FROM audit_events WHERE tenant_id = $1) AS audit_events,
         (SELECT count(*) FROM cases WHERE tenant_id = $1) AS cases,
         (SELECT count(*) FROM deletion_requests WHERE tenant_id = $1) AS deletion_requests,
         (SELECT count(*) FROM github_installation_states WHERE tenant_id = $1) AS github_installation_states,
         (SELECT count(*) FROM github_installations WHERE tenant_id = $1) AS github_installations,
         (SELECT count(*) FROM github_repositories WHERE tenant_id = $1) AS github_repositories,
         (SELECT count(*) FROM github_webhook_deliveries WHERE tenant_id = $1) AS github_webhook_deliveries,
         (SELECT count(*) FROM idempotency_keys WHERE tenant_id = $1) AS idempotency_keys,
         (SELECT count(*) FROM jobs WHERE tenant_id = $1) AS jobs,
         (SELECT count(*) FROM outbox_events WHERE tenant_id = $1) AS outbox_events,
         (SELECT count(*) FROM principals WHERE tenant_id = $1) AS principals,
         (SELECT count(*) FROM quota_ledger WHERE tenant_id = $1) AS quota_entries,
         (SELECT count(*) FROM run_evidence WHERE tenant_id = $1) AS run_evidence`,
      [tenantId],
    );
    const row = result.rows[0] ?? {};
    return {
      artifacts: integer(row.artifacts ?? 0),
      auditEvents: integer(row.audit_events ?? 0),
      cases: integer(row.cases ?? 0),
      deletionRequests: integer(row.deletion_requests ?? 0),
      githubInstallationStates: integer(row.github_installation_states ?? 0),
      githubInstallations: integer(row.github_installations ?? 0),
      githubRepositories: integer(row.github_repositories ?? 0),
      githubWebhookDeliveries: integer(row.github_webhook_deliveries ?? 0),
      idempotencyKeys: integer(row.idempotency_keys ?? 0),
      jobs: integer(row.jobs ?? 0),
      outboxEvents: integer(row.outbox_events ?? 0),
      principals: integer(row.principals ?? 0),
      quotaEntries: integer(row.quota_entries ?? 0),
      runEvidence: integer(row.run_evidence ?? 0),
    };
  }
}
