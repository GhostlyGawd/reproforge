import { PGlite } from "@electric-sql/pglite";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { DurableReproductionRecord } from "@/application/ports/production";
import { createCase } from "@/domain/case";
import { createJob } from "@/domain/job";
import { applyPostgresMigrations } from "@/infrastructure/postgres/migrations";
import { PostgresDurableReproductionRepository } from "@/infrastructure/postgres/repositories";

import { pgliteMigrationClient } from "./helpers/pglite-migration-client";
import { pglitePostgresDatabase } from "./helpers/pglite-postgres-database";

vi.setConfig({ hookTimeout: 30_000, testTimeout: 120_000 });

describe("Postgres repository idempotency properties", () => {
  let database: PGlite;
  let repository: PostgresDurableReproductionRepository;
  let sequence = 0;

  beforeAll(async () => {
    database = new PGlite();
    await applyPostgresMigrations(pgliteMigrationClient(database));
    repository = new PostgresDurableReproductionRepository(
      pglitePostgresDatabase(database),
    );
  });

  afterAll(async () => {
    await database.close();
  });

  it("creates exactly one record for every generated duplicate sequence", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 6 }),
        async (duplicateCount) => {
          sequence += 1;
          const tenantId = `tenant_property_${sequence}`;
          await database.query("INSERT INTO tenants (id) VALUES ($1)", [tenantId]);
          const candidates = Array.from(
            { length: duplicateCount },
            (_, index): DurableReproductionRecord => {
              const caseId = `case_property_${sequence}_${index}`;
              const jobId = `job_property_${sequence}_${index}`;
              const at = new Date("2026-07-19T20:00:00.000Z");
              return {
                callerId: "caller_property",
                caseId,
                commandHash: "a".repeat(64),
                createdAt: at.toISOString(),
                idempotencyKey: "same_property_key",
                jobId,
                snapshot: {
                  case: createCase(caseId, at),
                  job: createJob(jobId, caseId, at),
                  result: null,
                  sampleId: "cli-spaces",
                  schemaVersion: "2.0",
                },
                tenantId,
                updatedAt: at.toISOString(),
                version: 1,
              };
            },
          );

          const results = await Promise.all(
            candidates.map((candidate) => repository.reserve(candidate)),
          );
          expect(results.filter(({ created }) => created)).toHaveLength(1);
          expect(new Set(results.map(({ record }) => record.caseId)).size).toBe(1);

          const counts = await database.query<{
            cases: string;
            keys: string;
            jobs: string;
          }>(
            `SELECT
               (SELECT count(*) FROM cases WHERE tenant_id = $1)::text AS cases,
               (SELECT count(*) FROM jobs WHERE tenant_id = $1)::text AS jobs,
               (SELECT count(*) FROM idempotency_keys WHERE tenant_id = $1)::text AS keys`,
            [tenantId],
          );
          expect(counts.rows[0]).toEqual({ cases: "1", jobs: "1", keys: "1" });
        },
      ),
      { numRuns: 250 },
    );
  });
});
