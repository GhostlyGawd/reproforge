import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  PostgresAccountExportQuota,
  PostgresAccountExportQuotaError,
} from "@/infrastructure/operations/postgres-account-export-quota";
import { applyPostgresMigrations } from "@/infrastructure/postgres/migrations";

import { pgliteMigrationClient } from "./helpers/pglite-migration-client";
import { pglitePostgresDatabase } from "./helpers/pglite-postgres-database";

const AT = "2026-07-20T18:00:00.000Z";

describe("account export quota", () => {
  let database: PGlite;

  beforeEach(async () => {
    database = new PGlite();
    await applyPostgresMigrations(pgliteMigrationClient(database));
    await database.query(
      "INSERT INTO tenants (id) VALUES ('tenant_export_quota')",
    );
    await database.query(
      `INSERT INTO principals (
         tenant_id, id, provider, issuer, external_subject
       ) VALUES (
         'tenant_export_quota', 'principal_export_quota', 'auth0',
         'https://identity.example/', 'subject_export_quota'
       )`,
    );
  });

  afterEach(async () => database.close());

  it("bounds a UTC export window while preserving idempotent retries", async () => {
    const quota = new PostgresAccountExportQuota(
      pglitePostgresDatabase(database),
      { limit: 2 },
    );
    const input = (idempotencyKey: string) => ({
      at: AT,
      idempotencyKey,
      principalId: "principal_export_quota",
      tenantId: "tenant_export_quota",
    });

    await expect(quota.consume(input("export-1"))).resolves.toEqual({
      allowed: true,
      reused: false,
    });
    await expect(quota.consume(input("export-1"))).resolves.toEqual({
      allowed: true,
      reused: true,
    });
    await expect(quota.consume(input("export-2"))).resolves.toEqual({
      allowed: true,
      reused: false,
    });
    await expect(quota.consume(input("export-3"))).resolves.toEqual({
      allowed: false,
      reused: false,
    });
    const rows = await database.query<{
      actual_amount: number;
      case_id: string | null;
      job_id: string | null;
      state: string;
    }>(
      `SELECT actual_amount, case_id, job_id, state
         FROM quota_ledger ORDER BY id`,
    );
    expect(rows.rows).toEqual([
      { actual_amount: 1, case_id: null, job_id: null, state: "COMMITTED" },
      { actual_amount: 1, case_id: null, job_id: null, state: "COMMITTED" },
    ]);
  });

  it("rejects a suspended tenant before consuming quota", async () => {
    await database.query(
      "UPDATE tenants SET status = 'SUSPENDED' WHERE id = 'tenant_export_quota'",
    );
    const quota = new PostgresAccountExportQuota(
      pglitePostgresDatabase(database),
    );

    await expect(
      quota.consume({
        at: AT,
        idempotencyKey: "export-suspended",
        principalId: "principal_export_quota",
        tenantId: "tenant_export_quota",
      }),
    ).rejects.toBeInstanceOf(PostgresAccountExportQuotaError);
    const rows = await database.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM quota_ledger",
    );
    expect(rows.rows[0]?.count).toBe("0");
  });
});
