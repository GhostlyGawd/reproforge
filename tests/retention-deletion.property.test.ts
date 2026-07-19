import { PGlite } from "@electric-sql/pglite";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { applyPostgresMigrations } from "@/infrastructure/postgres/migrations";
import { PostgresUnitOfWork } from "@/infrastructure/postgres/repositories";
import { PostgresTenantDataRetention } from "@/infrastructure/retention/postgres-tenant-data-retention";
import {
  DURABLE_AT,
  seedDurableTenant,
} from "./helpers/durable-fixture";
import { MemoryPrivateBlobClient } from "./helpers/memory-private-blob-client";
import { pgliteMigrationClient } from "./helpers/pglite-migration-client";
import { pglitePostgresDatabase } from "./helpers/pglite-postgres-database";

vi.setConfig({ hookTimeout: 120_000, testTimeout: 120_000 });

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
let sequence = 0;

beforeAll(async () => {
  database = new PGlite();
  await applyPostgresMigrations(pgliteMigrationClient(database));
  postgres = pglitePostgresDatabase(database);
  unitOfWork = new PostgresUnitOfWork(postgres);
});

afterAll(async () => database.close());

describe("retention deletion properties", () => {
  it("isolates tenants and leaves only the documented tombstone over 250 generated sequences", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 3 }),
        async (extraAuditEvents) => {
          const suffix = sequence++;
          const tenantId = `tenant_delete_property_${suffix}`;
          const neighborId = `tenant_delete_neighbor_${suffix}`;
          await seedDurableTenant(database, unitOfWork, tenantId);
          await seedDurableTenant(database, unitOfWork, neighborId);
          for (let index = 0; index < extraAuditEvents; index += 1) {
            await database.query(
              `INSERT INTO audit_events (
                 tenant_id, id, actor_id, action, target_type, target_id,
                 outcome, metadata, occurred_at, retention_until
               ) VALUES ($1, $2, 'system_test', 'case.read', 'case', $3,
                         'success', '{}'::jsonb, $4, $5)`,
              [
                tenantId,
                `audit_extra_${index}`,
                `case_${tenantId}`,
                DURABLE_AT,
                "2099-07-20T20:00:00.000Z",
              ],
            );
          }
          await database.query(
            `UPDATE tenants SET retention_until = $2, updated_at = $2 WHERE id = $1`,
            [tenantId, "2026-07-20T20:00:00.000Z"],
          );
          const retention = new PostgresTenantDataRetention(
            postgres,
            new MemoryPrivateBlobClient(),
          );

          expect(await retention.scheduleDue({ at: DELETE_AT, limit: 1 })).toHaveLength(1);
          await retention.executeNext({ at: DELETE_AT });

          for (const table of CUSTOMER_TABLES) {
            const deleted = await database.query<{ count: string }>(
              `SELECT count(*)::text AS count FROM ${table} WHERE tenant_id = $1`,
              [tenantId],
            );
            expect(deleted.rows[0]?.count, table).toBe("0");
          }
          const tombstone = await database.query<{ action: string }>(
            `SELECT action FROM audit_events WHERE tenant_id = $1`,
            [tenantId],
          );
          expect(tombstone.rows).toEqual([{ action: "account.deleted" }]);
          const neighbor = await database.query<{ count: string }>(
            `SELECT count(*)::text AS count FROM cases WHERE tenant_id = $1`,
            [neighborId],
          );
          expect(neighbor.rows[0]?.count).toBe("1");
        },
      ),
      { numRuns: 250 },
    );
  });
});
