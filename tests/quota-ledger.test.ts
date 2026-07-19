import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { applyPostgresMigrations } from "@/infrastructure/postgres/migrations";
import { PostgresQuotaLedger } from "@/infrastructure/postgres/repositories";
import { pgliteMigrationClient } from "./helpers/pglite-migration-client";
import { pglitePostgresDatabase } from "./helpers/pglite-postgres-database";
import { DURABLE_AT, DURABLE_EXPIRY } from "./helpers/durable-fixture";

vi.setConfig({ hookTimeout: 30_000, testTimeout: 30_000 });

let database: PGlite;
let postgres: ReturnType<typeof pglitePostgresDatabase>;

async function seedJobs(tenantId: string, count: number): Promise<void> {
  await database.query(
    `INSERT INTO tenants (id, created_at, updated_at)
     VALUES ($1, $2, $2)`,
    [tenantId, DURABLE_AT],
  );
  for (let index = 0; index < count; index += 1) {
    await database.query(
      `INSERT INTO cases (
         tenant_id, id, source_kind, source_descriptor, domain_state,
         created_at, updated_at, retention_until
       ) VALUES ($1, $2, 'trusted-sample', '{}'::jsonb, '{}'::jsonb, $3, $3, $4)`,
      [tenantId, `case_${index}`, DURABLE_AT, DURABLE_EXPIRY],
    );
    await database.query(
      `INSERT INTO jobs (
         tenant_id, id, case_id, created_at, updated_at, retention_until
       ) VALUES ($1, $2, $3, $4, $4, $5)`,
      [tenantId, `job_${index}`, `case_${index}`, DURABLE_AT, DURABLE_EXPIRY],
    );
  }
}

function reservation(tenantId: string, index: number, amount = 1) {
  return {
    amount,
    caseId: `case_${index}`,
    expiresAt: DURABLE_EXPIRY,
    jobId: `job_${index}`,
    reservationId: `reservation_${index}`,
    resource: "active-jobs" as const,
    tenantId,
  };
}

beforeAll(async () => {
  database = new PGlite();
  await applyPostgresMigrations(pgliteMigrationClient(database));
  postgres = pglitePostgresDatabase(database);
});

afterAll(async () => database.close());

describe("Postgres quota ledger", () => {
  it("atomically refuses reservations above the configured hard limit", async () => {
    const tenantId = "tenant_quota_limit";
    await seedJobs(tenantId, 8);
    const ledger = new PostgresQuotaLedger(postgres, { "active-jobs": 2 });

    await expect(ledger.reserve(reservation(tenantId, 0))).resolves.toBe(true);
    await expect(ledger.reserve(reservation(tenantId, 1))).resolves.toBe(true);
    await expect(ledger.reserve(reservation(tenantId, 2))).resolves.toBe(false);

    const rows = await database.query<{ total: string }>(
      `SELECT coalesce(sum(reserved_amount), 0)::text AS total
         FROM quota_ledger
        WHERE tenant_id = $1 AND resource = 'active-jobs'
          AND state IN ('RESERVED', 'COMMITTED')`,
      [tenantId],
    );
    expect(Number(rows.rows[0]?.total)).toBe(2);
  });

  it("serializes concurrent contenders and never oversubscribes", async () => {
    const tenantId = "tenant_quota_concurrent";
    await seedJobs(tenantId, 16);
    const ledger = new PostgresQuotaLedger(postgres, { "active-jobs": 3 });

    const outcomes = await Promise.all(
      Array.from({ length: 16 }, (_, index) =>
        ledger.reserve(reservation(tenantId, index)),
      ),
    );

    expect(outcomes.filter(Boolean)).toHaveLength(3);
  });

  it("returns capacity when a job-linked reservation is released", async () => {
    const tenantId = "tenant_quota_release";
    await seedJobs(tenantId, 3);
    const ledger = new PostgresQuotaLedger(postgres, { "active-jobs": 1 });
    await ledger.reserve(reservation(tenantId, 0));

    await expect(
      ledger.releaseForJob(tenantId, "job_0", DURABLE_AT),
    ).resolves.toBe(1);
    await expect(ledger.reserve(reservation(tenantId, 1))).resolves.toBe(true);
    await expect(
      ledger.releaseForJob(tenantId, "job_0", DURABLE_AT),
    ).resolves.toBe(0);
  });
});
