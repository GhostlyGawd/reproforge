import { createHash } from "node:crypto";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { ContentAddressedArtifactStore } from "@/infrastructure/artifacts/content-addressed-store";
import { applyPostgresMigrations } from "@/infrastructure/postgres/migrations";
import { PostgresUnitOfWork } from "@/infrastructure/postgres/repositories";
import { PostgresTenantDataRetention } from "@/infrastructure/retention/postgres-tenant-data-retention";
import {
  DURABLE_AT,
  DURABLE_EXPIRY,
  durableScope,
  seedDurableTenant,
} from "./helpers/durable-fixture";
import { MemoryPrivateBlobClient } from "./helpers/memory-private-blob-client";
import { pgliteMigrationClient } from "./helpers/pglite-migration-client";
import { pglitePostgresDatabase } from "./helpers/pglite-postgres-database";

vi.setConfig({ hookTimeout: 30_000, testTimeout: 30_000 });

const DELETE_AT = "2026-07-22T20:00:00.000Z";
const CUSTOMER_TABLES = [
  "principals",
  "cases",
  "jobs",
  "idempotency_keys",
  "run_evidence",
  "artifacts",
  "outbox_events",
  "quota_ledger",
  "deletion_requests",
] as const;

let database: PGlite;
let postgres: ReturnType<typeof pglitePostgresDatabase>;
let unitOfWork: PostgresUnitOfWork;

async function tenantCount(table: (typeof CUSTOMER_TABLES)[number], tenantId: string) {
  const result = await database.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM ${table} WHERE tenant_id = $1`,
    [tenantId],
  );
  return Number(result.rows[0]?.count);
}

beforeAll(async () => {
  database = new PGlite();
  await applyPostgresMigrations(pgliteMigrationClient(database));
  postgres = pglitePostgresDatabase(database);
  unitOfWork = new PostgresUnitOfWork(postgres);
});

afterAll(async () => database.close());

describe("tenant retention deletion", () => {
  it("removes customer rows and private objects while preserving one audit tombstone", async () => {
    const tenantId = "tenant_retention_due";
    const record = await seedDurableTenant(database, unitOfWork, tenantId);
    await database.query(
      `UPDATE tenants SET retention_until = $2, updated_at = $2 WHERE id = $1`,
      [tenantId, "2026-07-20T20:00:00.000Z"],
    );
    const blobs = new MemoryPrivateBlobClient();
    const artifacts = new ContentAddressedArtifactStore(postgres, blobs, {
      now: () => new Date(DURABLE_AT),
    });
    const bytes = new TextEncoder().encode("private retention proof");
    const digest = createHash("sha256").update(bytes).digest("hex");
    const descriptor = {
      artifactId: "artifact_retention",
      byteCount: bytes.byteLength,
      caseId: record.caseId,
      createdAt: DURABLE_AT,
      kind: "bundle" as const,
      objectKey: `tenants/${tenantId}/cases/${record.caseId}/bundle/${digest}`,
      retentionUntil: DURABLE_EXPIRY,
      sha256: digest,
      tenantId,
    };
    await artifacts.put({ bytes, descriptor });
    const retention = new PostgresTenantDataRetention(postgres, blobs);

    await expect(retention.scheduleDue({ at: DELETE_AT, limit: 10 })).resolves.toHaveLength(1);
    const result = await retention.executeNext({ at: DELETE_AT });

    expect(result).toMatchObject({ tenantId });
    expect(result?.classResults.artifacts).toBe(1);
    expect(blobs.has(descriptor.objectKey)).toBe(false);
    for (const table of CUSTOMER_TABLES) {
      await expect(tenantCount(table, tenantId), table).resolves.toBe(0);
    }
    const tenant = await database.query<{ deleted_at: Date; status: string }>(
      `SELECT status, deleted_at FROM tenants WHERE id = $1`,
      [tenantId],
    );
    expect(tenant.rows[0]?.status).toBe("DELETED");
    expect(tenant.rows[0]?.deleted_at.toISOString()).toBe(DELETE_AT);
    const tombstones = await database.query<{
      action: string;
      actor_id: string;
      metadata: unknown;
      target_id: string;
    }>(`SELECT action, actor_id, metadata, target_id FROM audit_events WHERE tenant_id = $1`, [tenantId]);
    expect(tombstones.rows).toEqual([
      {
        action: "account.deleted",
        actor_id: "system_retention",
        metadata: { reason: "retention" },
        target_id: tenantId,
      },
    ]);
    await expect(
      database.query(`UPDATE audit_events SET outcome = 'failure' WHERE tenant_id = $1`, [tenantId]),
    ).rejects.toThrow(/append-only/);
    await expect(
      database.query(`DELETE FROM audit_events WHERE tenant_id = $1`, [tenantId]),
    ).rejects.toThrow(/append-only/);
  });

  it("fails closed before the database purge when a provider object remains", async () => {
    const tenantId = "tenant_retention_provider_failure";
    const record = await seedDurableTenant(database, unitOfWork, tenantId);
    await database.query(
      `UPDATE tenants SET retention_until = $2, updated_at = $2 WHERE id = $1`,
      [tenantId, "2026-07-20T20:00:00.000Z"],
    );
    class FailingBlobClient extends MemoryPrivateBlobClient {
      override async delete(): Promise<boolean> {
        return false;
      }
    }
    const blobs = new FailingBlobClient();
    const artifacts = new ContentAddressedArtifactStore(postgres, blobs, {
      now: () => new Date(DURABLE_AT),
    });
    const bytes = new TextEncoder().encode("must remain represented");
    const digest = createHash("sha256").update(bytes).digest("hex");
    await artifacts.put({
      bytes,
      descriptor: {
        artifactId: "artifact_failure",
        byteCount: bytes.byteLength,
        caseId: record.caseId,
        createdAt: DURABLE_AT,
        kind: "source",
        objectKey: `tenants/${tenantId}/cases/${record.caseId}/source/${digest}`,
        retentionUntil: DURABLE_EXPIRY,
        sha256: digest,
        tenantId,
      },
    });
    const retention = new PostgresTenantDataRetention(postgres, blobs);
    await retention.scheduleDue({ at: DELETE_AT, limit: 1 });

    await expect(retention.executeNext({ at: DELETE_AT })).rejects.toMatchObject({
      code: "RETENTION_PROVIDER_FAILURE",
    });
    await expect(tenantCount("cases", tenantId)).resolves.toBe(1);
    await expect(tenantCount("artifacts", tenantId)).resolves.toBe(1);
    const request = await database.query<{ failure_code: string; state: string }>(
      `SELECT state, failure_code FROM deletion_requests WHERE tenant_id = $1`,
      [tenantId],
    );
    expect(request.rows[0]).toEqual({
      failure_code: "RETENTION_PROVIDER_FAILURE",
      state: "FAILED",
    });
  });

  it("supports an idempotent caller-requested deletion schedule", async () => {
    const tenantId = "tenant_manual_deletion";
    await seedDurableTenant(database, unitOfWork, tenantId);
    const retention = new PostgresTenantDataRetention(
      postgres,
      new MemoryPrivateBlobClient(),
    );
    const request = {
      at: DURABLE_AT,
      requestId: "delete_manual",
      scheduledAt: DELETE_AT,
      scope: durableScope(tenantId),
    };

    await expect(retention.request(request)).resolves.toMatchObject({ created: true });
    await expect(retention.request(request)).resolves.toMatchObject({ created: false });
    const rows = await database.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM deletion_requests WHERE tenant_id = $1`,
      [tenantId],
    );
    expect(rows.rows[0]?.count).toBe("1");
  });

  it("reclaims an expired deletion lease after a worker crash", async () => {
    const tenantId = "tenant_retention_recovery";
    await seedDurableTenant(database, unitOfWork, tenantId);
    await database.query(
      `UPDATE tenants SET retention_until = $2, updated_at = $2 WHERE id = $1`,
      [tenantId, "2026-07-20T20:00:00.000Z"],
    );
    const retention = new PostgresTenantDataRetention(
      postgres,
      new MemoryPrivateBlobClient(),
    );
    await retention.request({
      at: "2026-07-21T20:00:00.000Z",
      requestId: "retention_recovery_request",
      scheduledAt: "2026-07-21T20:00:00.000Z",
      scope: durableScope(tenantId),
    });
    await database.query(
      `UPDATE deletion_requests
          SET state = 'RUNNING', claim_owner = 'worker_crashed',
              claim_expires_at = '2026-07-22T19:00:00.000Z',
              updated_at = '2026-07-21T20:00:00.000Z',
              version = version + 1
        WHERE tenant_id = $1`,
      [tenantId],
    );
    await database.query(
      `UPDATE tenants SET status = 'DELETING',
          updated_at = '2026-07-21T20:00:00.000Z'
        WHERE id = $1`,
      [tenantId],
    );

    await expect(
      retention.executeNext({ at: DELETE_AT, ownerId: "worker_recovery" }),
    ).resolves.toMatchObject({ tenantId });
    const tenant = await database.query<{ status: string }>(
      "SELECT status FROM tenants WHERE id = $1",
      [tenantId],
    );
    expect(tenant.rows[0]?.status).toBe("DELETED");
  });
});
