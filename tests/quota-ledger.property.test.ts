import { PGlite } from "@electric-sql/pglite";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { applyPostgresMigrations } from "@/infrastructure/postgres/migrations";
import { PostgresQuotaLedger } from "@/infrastructure/postgres/repositories";
import { DURABLE_AT, DURABLE_EXPIRY } from "./helpers/durable-fixture";
import { pgliteMigrationClient } from "./helpers/pglite-migration-client";
import { pglitePostgresDatabase } from "./helpers/pglite-postgres-database";

vi.setConfig({ hookTimeout: 120_000, testTimeout: 120_000 });

type Operation =
  | { index: number; kind: "reserve" }
  | { index: number; kind: "release" };

let database: PGlite;
let postgres: ReturnType<typeof pglitePostgresDatabase>;
let sequence = 0;

beforeAll(async () => {
  database = new PGlite();
  await applyPostgresMigrations(pgliteMigrationClient(database));
  postgres = pglitePostgresDatabase(database);
});

afterAll(async () => database.close());

describe("quota reservation properties", () => {
  it("never goes negative or exceeds its hard limit over 250 generated sequences", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 5 }),
        fc.array(
          fc.record({
            index: fc.integer({ min: 0, max: 7 }),
            kind: fc.constantFrom("reserve", "release"),
          }) as fc.Arbitrary<Operation>,
          { minLength: 1, maxLength: 24 },
        ),
        async (hardLimit, operations) => {
          const tenantId = `tenant_quota_property_${sequence++}`;
          await database.query(
            `INSERT INTO tenants (id, created_at, updated_at)
             VALUES ($1, $2, $2)`,
            [tenantId, DURABLE_AT],
          );
          for (let index = 0; index < 8; index += 1) {
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
          const ledger = new PostgresQuotaLedger(postgres, {
            "active-jobs": hardLimit,
          });

          for (const operation of operations) {
            if (operation.kind === "reserve") {
              await ledger.reserve({
                amount: 1,
                caseId: `case_${operation.index}`,
                expiresAt: DURABLE_EXPIRY,
                jobId: `job_${operation.index}`,
                reservationId: `reservation_${operation.index}`,
                resource: "active-jobs",
                tenantId,
              });
            } else {
              await ledger.releaseForJob(
                tenantId,
                `job_${operation.index}`,
                DURABLE_AT,
              );
            }
            const usage = await database.query<{ total: string }>(
              `SELECT coalesce(sum(
                 CASE WHEN state = 'COMMITTED' THEN actual_amount
                      WHEN state = 'RESERVED' THEN reserved_amount ELSE 0 END
               ), 0)::text AS total
                 FROM quota_ledger
                WHERE tenant_id = $1 AND resource = 'active-jobs'`,
              [tenantId],
            );
            expect(Number(usage.rows[0]?.total)).toBeGreaterThanOrEqual(0);
            expect(Number(usage.rows[0]?.total)).toBeLessThanOrEqual(hardLimit);
          }
        },
      ),
      { numRuns: 250 },
    );
  });
});
