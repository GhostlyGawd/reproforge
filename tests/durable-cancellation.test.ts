import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { requestDurableCancellation } from "@/application/durable-cancellation";
import { DurableQueueConsumer } from "@/application/durable-queue-consumer";
import { applyPostgresMigrations } from "@/infrastructure/postgres/migrations";
import {
  PostgresDurableReproductionRepository,
  PostgresUnitOfWork,
} from "@/infrastructure/postgres/repositories";
import {
  DURABLE_AT,
  durableScope,
  seedDurableTenant,
} from "./helpers/durable-fixture";
import { pgliteMigrationClient } from "./helpers/pglite-migration-client";
import { pglitePostgresDatabase } from "./helpers/pglite-postgres-database";

vi.setConfig({ hookTimeout: 30_000, testTimeout: 30_000 });

let database: PGlite;
let postgres: ReturnType<typeof pglitePostgresDatabase>;
let repository: PostgresDurableReproductionRepository;
let unitOfWork: PostgresUnitOfWork;

beforeAll(async () => {
  database = new PGlite();
  await applyPostgresMigrations(pgliteMigrationClient(database));
  postgres = pglitePostgresDatabase(database);
  repository = new PostgresDurableReproductionRepository(postgres);
  unitOfWork = new PostgresUnitOfWork(postgres);
});

afterAll(async () => database.close());

describe("durable cancellation", () => {
  it("terminally cancels a queued job without ever starting an attempt", async () => {
    const tenantId = "tenant_cancel_queued";
    const record = await seedDurableTenant(database, unitOfWork, tenantId);

    await expect(
      requestDurableCancellation(unitOfWork, {
        at: DURABLE_AT,
        jobId: record.jobId,
        scope: durableScope(tenantId),
      }),
    ).resolves.toEqual({
      accepted: true,
      changed: true,
      disposition: "cancelled",
    });

    await expect(
      repository.findByJobId(durableScope(tenantId), record.jobId),
    ).resolves.toMatchObject({
      snapshot: {
        case: { state: "CANCELLED" },
        job: { attempt: 0, progressPhase: "CANCELLED", state: "CANCELLED" },
      },
      version: 2,
    });
    await expect(
      repository.claimLease({
        at: DURABLE_AT,
        jobId: record.jobId,
        leaseSeconds: 90,
        ownerId: "worker_cancelled",
        tenantId,
      }),
    ).resolves.toBeNull();

    const state = await database.query<{
      cancellation_requested_at: Date;
      cancelled_at: Date;
      quota_state: string;
    }>(
      `SELECT j.cancellation_requested_at, j.cancelled_at, q.state AS quota_state
         FROM jobs j
         JOIN quota_ledger q
           ON q.tenant_id = j.tenant_id AND q.job_id = j.id
        WHERE j.tenant_id = $1 AND j.id = $2`,
      [tenantId, record.jobId],
    );
    expect(state.rows[0]).toMatchObject({ quota_state: "RELEASED" });
    expect(state.rows[0]?.cancellation_requested_at.toISOString()).toBe(DURABLE_AT);
    expect(state.rows[0]?.cancelled_at.toISOString()).toBe(DURABLE_AT);
  });

  it("is idempotent and emits one sanitized audit and cancellation intent", async () => {
    const tenantId = "tenant_cancel_idempotent";
    const record = await seedDurableTenant(database, unitOfWork, tenantId);
    const input = {
      at: DURABLE_AT,
      jobId: record.jobId,
      scope: durableScope(tenantId),
    };

    await requestDurableCancellation(unitOfWork, input);
    await expect(requestDurableCancellation(unitOfWork, input)).resolves.toEqual({
      accepted: true,
      changed: false,
      disposition: "cancelled",
    });

    const sideEffects = await database.query<{ audits: string; intents: string }>(
      `SELECT
         (SELECT count(*)::text FROM audit_events
           WHERE tenant_id = $1 AND action = 'job.cancellation-requested') AS audits,
         (SELECT count(*)::text FROM outbox_events
           WHERE tenant_id = $1 AND kind = 'reproduction.cancelled') AS intents`,
      [tenantId],
    );
    expect(sideEffects.rows[0]).toEqual({ audits: "1", intents: "1" });
  });

  it("records a cooperative flag for running work and exposes it to the lease owner", async () => {
    const tenantId = "tenant_cancel_running";
    const record = await seedDurableTenant(database, unitOfWork, tenantId);
    const lease = await repository.claimLease({
      at: DURABLE_AT,
      jobId: record.jobId,
      leaseSeconds: 90,
      ownerId: "worker_running",
      tenantId,
    });
    expect(lease).not.toBeNull();

    await expect(
      requestDurableCancellation(unitOfWork, {
        at: DURABLE_AT,
        jobId: record.jobId,
        scope: durableScope(tenantId),
      }),
    ).resolves.toMatchObject({ disposition: "requested" });
    await expect(repository.isCancellationRequested(lease!)).resolves.toBe(true);

    const current = await repository.findByLease(lease!);
    expect(current).toMatchObject({ snapshot: { job: { state: "RUNNING" } } });
    const quota = await database.query<{ state: string }>(
      `SELECT state FROM quota_ledger WHERE tenant_id = $1 AND job_id = $2`,
      [tenantId, record.jobId],
    );
    expect(quota.rows[0]?.state).toBe("RESERVED");
  });

  it("lets the queue worker cooperatively finish a requested running cancellation", async () => {
    const tenantId = "tenant_cancel_cooperative";
    const record = await seedDurableTenant(database, unitOfWork, tenantId);
    const consumer = new DurableQueueConsumer({
      clock: { now: () => new Date(DURABLE_AT) },
      leaseSeconds: 90,
      repository,
      worker: {
        execute: async ({ record: claimed }) => {
          await requestDurableCancellation(unitOfWork, {
            at: DURABLE_AT,
            jobId: claimed.jobId,
            scope: durableScope(tenantId),
          });
          return claimed;
        },
      },
    });

    await expect(
      consumer.consume(
        {
          caseId: record.caseId,
          eventId: `delivery_${record.caseId}`,
          jobId: record.jobId,
          kind: "reproduction.requested",
          schemaVersion: "1.0",
          tenantId,
        },
        "worker_cooperative",
      ),
    ).resolves.toEqual({ attempt: 1, outcome: "cancelled" });
    await expect(
      repository.findByJobId(durableScope(tenantId), record.jobId),
    ).resolves.toMatchObject({
      snapshot: {
        case: { state: "CANCELLED" },
        job: { attempt: 1, state: "CANCELLED" },
      },
      version: 4,
    });
    const quota = await database.query<{ state: string }>(
      `SELECT state FROM quota_ledger WHERE tenant_id = $1 AND job_id = $2`,
      [tenantId, record.jobId],
    );
    expect(quota.rows[0]?.state).toBe("RELEASED");
  });

  it("does not disclose or mutate a job to an unauthorized tenant", async () => {
    const tenantId = "tenant_cancel_owner";
    const record = await seedDurableTenant(database, unitOfWork, tenantId);
    await database.query(
      `INSERT INTO tenants (id, created_at, updated_at) VALUES ($1, $2, $2)`,
      ["tenant_cancel_other", DURABLE_AT],
    );

    await expect(
      requestDurableCancellation(unitOfWork, {
        at: DURABLE_AT,
        jobId: record.jobId,
        scope: durableScope("tenant_cancel_other"),
      }),
    ).resolves.toEqual({
      accepted: false,
      changed: false,
      disposition: "not-found",
    });
    await expect(
      repository.claimLease({
        at: DURABLE_AT,
        jobId: record.jobId,
        leaseSeconds: 90,
        ownerId: "worker_owner",
        tenantId,
      }),
    ).resolves.not.toBeNull();
  });
});
