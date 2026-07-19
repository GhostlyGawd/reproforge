import { PGlite } from "@electric-sql/pglite";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { DurableQueueConsumer } from "@/application/durable-queue-consumer";
import { transitionCase } from "@/domain/case";
import { transitionJob } from "@/domain/job";
import { applyPostgresMigrations } from "@/infrastructure/postgres/migrations";
import { PostgresDurableReproductionRepository } from "@/infrastructure/postgres/repositories";

import {
  DURABLE_AT,
  durableRecord,
  queueMessage,
} from "./helpers/durable-postgres-fixture";
import { pgliteMigrationClient } from "./helpers/pglite-migration-client";
import { pglitePostgresDatabase } from "./helpers/pglite-postgres-database";

vi.setConfig({ hookTimeout: 30_000, testTimeout: 120_000 });

describe("durable queue delivery properties", () => {
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

  it("makes every duplicate and out-of-order delivery sequence one terminal attempt", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom("original" as const, "recovery" as const), {
          minLength: 1,
          maxLength: 12,
        }),
        async (deliveries) => {
          sequence += 1;
          const suffix = `delivery_${sequence}`;
          const record = durableRecord(`tenant_${suffix}`, suffix);
          await database.query("INSERT INTO tenants (id) VALUES ($1)", [
            record.tenantId,
          ]);
          await repository.reserve(record);
          let executions = 0;
          const consumer = new DurableQueueConsumer({
            clock: { now: () => new Date(DURABLE_AT) },
            leaseSeconds: 60,
            repository,
            worker: {
              execute: async ({ record: claimed }) => {
                executions += 1;
                const at = new Date("2026-07-19T20:00:01.000Z");
                return {
                  ...claimed,
                  snapshot: {
                    ...claimed.snapshot,
                    case: transitionCase(
                      claimed.snapshot.case,
                      "CANCELLED",
                      "generated property completion",
                      at,
                    ),
                    job: transitionJob(claimed.snapshot.job, "CANCELLED", {
                      at,
                      progressPhase: "CANCELLED",
                    }),
                  },
                  updatedAt: at.toISOString(),
                };
              },
            },
          });

          for (const [index, delivery] of deliveries.entries()) {
            await consumer.consume(
              queueMessage(
                record,
                delivery === "original"
                  ? "reproduction.requested"
                  : "reproduction.recovery-requested",
                `${delivery}_${record.caseId}_${index}`,
              ),
              `worker_${sequence}_${index}`,
            );
          }

          expect(executions).toBe(1);
          const stored = await repository.findByCaseId(
            {
              callerId: record.callerId,
              principalId: record.callerId,
              tenantId: record.tenantId,
            },
            record.caseId,
          );
          expect(stored).toMatchObject({
            snapshot: { job: { attempt: 1, state: "CANCELLED" } },
          });
        },
      ),
      { numRuns: 250 },
    );
  });
});
