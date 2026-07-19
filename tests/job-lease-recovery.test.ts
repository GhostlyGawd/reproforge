import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyPostgresMigrations } from "@/infrastructure/postgres/migrations";
import { transitionJob } from "@/domain/job";
import {
  LeaseOwnershipError,
  PostgresDurableReproductionRepository,
} from "@/infrastructure/postgres/repositories";

import {
  DURABLE_AT,
  durableRecord,
} from "./helpers/durable-postgres-fixture";
import { pgliteMigrationClient } from "./helpers/pglite-migration-client";
import { pglitePostgresDatabase } from "./helpers/pglite-postgres-database";

vi.setConfig({ hookTimeout: 30_000, testTimeout: 30_000 });

describe("Postgres job leases and recovery", () => {
  let database: PGlite;
  let repository: PostgresDurableReproductionRepository;

  beforeEach(async () => {
    database = new PGlite();
    await applyPostgresMigrations(pgliteMigrationClient(database));
    repository = new PostgresDurableReproductionRepository(
      pglitePostgresDatabase(database),
    );
  });

  afterEach(async () => {
    await database.close();
  });

  async function seed(suffix: string) {
    const record = durableRecord(`tenant_${suffix}`, suffix);
    await database.query("INSERT INTO tenants (id) VALUES ($1)", [record.tenantId]);
    await repository.reserve(record);
    return record;
  }

  it("refuses to transition a queued job without a lease", async () => {
    const record = await seed("lease_required");
    const at = new Date("2026-07-19T20:00:01.000Z");
    await expect(
      repository.save(
        {
          ...record,
          snapshot: {
            ...record.snapshot,
            job: transitionJob(record.snapshot.job, "RUNNING", {
              at,
              progressPhase: "INGESTING",
            }),
          },
          updatedAt: at.toISOString(),
        },
        1,
      ),
    ).rejects.toMatchObject({ code: "OPTIMISTIC_CONFLICT" });
  });

  it("claims exactly once, keeps case/job versions readable, and rejects another owner", async () => {
    const record = await seed("lease_owner");
    const lease = await repository.claimLease({
      at: DURABLE_AT,
      jobId: record.jobId,
      leaseSeconds: 60,
      ownerId: "worker_primary",
      tenantId: record.tenantId,
    });

    expect(lease).toMatchObject({ attempt: 1, ownerId: "worker_primary" });
    await expect(
      repository.claimLease({
        at: DURABLE_AT,
        jobId: record.jobId,
        leaseSeconds: 60,
        ownerId: "worker_duplicate",
        tenantId: record.tenantId,
      }),
    ).resolves.toBeNull();
    await expect(
      repository.findByCaseId(
        {
          callerId: record.callerId,
          principalId: record.callerId,
          tenantId: record.tenantId,
        },
        record.caseId,
      ),
    ).resolves.toMatchObject({
      snapshot: { job: { attempt: 1, state: "RUNNING" } },
      version: 2,
    });
    await expect(
      repository.renewLease(
        { ...lease!, ownerId: "worker_intruder" },
        {
          at: "2026-07-19T20:00:30.000Z",
          expiresAt: "2026-07-19T20:02:00.000Z",
        },
      ),
    ).rejects.toBeInstanceOf(LeaseOwnershipError);
  });

  it("recovers one expired lease exactly once and republishes a recovery intent", async () => {
    const record = await seed("recover_once");
    await repository.claimLease({
      at: DURABLE_AT,
      jobId: record.jobId,
      leaseSeconds: 60,
      ownerId: "worker_crashed",
      tenantId: record.tenantId,
    });

    await expect(
      repository.recoverExpiredLeases({
        at: "2026-07-19T20:02:00.000Z",
        limit: 10,
      }),
    ).resolves.toEqual({ cancelled: 0, exhausted: 0, requeued: 1 });
    await expect(
      repository.recoverExpiredLeases({
        at: "2026-07-19T20:02:00.000Z",
        limit: 10,
      }),
    ).resolves.toEqual({ cancelled: 0, exhausted: 0, requeued: 0 });

    const jobs = await database.query<{
      attempt: number;
      lease_owner: string | null;
      state: string;
    }>(
      "SELECT state, attempt, lease_owner FROM jobs WHERE tenant_id = $1",
      [record.tenantId],
    );
    expect(jobs.rows).toEqual([
      { attempt: 1, lease_owner: null, state: "QUEUED" },
    ]);
    const events = await database.query<{ kind: string; status: string }>(
      "SELECT kind, status FROM outbox_events WHERE tenant_id = $1",
      [record.tenantId],
    );
    expect(events.rows).toEqual([
      { kind: "reproduction.recovery-requested", status: "PENDING" },
    ]);
  });

  it("renews and gracefully releases only the exact active lease", async () => {
    const record = await seed("renew_release");
    const lease = await repository.claimLease({
      at: DURABLE_AT,
      jobId: record.jobId,
      leaseSeconds: 60,
      ownerId: "worker_renewing",
      tenantId: record.tenantId,
    });
    expect(lease).not.toBeNull();
    const renewed = await repository.renewLease(lease!, {
      at: "2026-07-19T20:00:30.000Z",
      expiresAt: "2026-07-19T20:02:00.000Z",
    });
    expect(renewed.expiresAt).toBe("2026-07-19T20:02:00.000Z");
    await expect(
      repository.releaseLease(lease!, {
        at: "2026-07-19T20:00:45.000Z",
        nextAttemptAt: "2026-07-19T20:00:50.000Z",
      }),
    ).rejects.toBeInstanceOf(LeaseOwnershipError);
    await expect(
      repository.releaseLease(renewed, {
        at: "2026-07-19T20:00:45.000Z",
        nextAttemptAt: "2026-07-19T20:00:50.000Z",
      }),
    ).resolves.toBeUndefined();

    await expect(
      repository.findByCaseId(
        {
          callerId: record.callerId,
          principalId: record.callerId,
          tenantId: record.tenantId,
        },
        record.caseId,
      ),
    ).resolves.toMatchObject({
      snapshot: { job: { attempt: 1, state: "QUEUED" } },
      version: 4,
    });
  });

  it("cannot complete a successful job before its bundle is durably available", async () => {
    const record = await seed("bundle_required");
    const lease = await repository.claimLease({
      at: DURABLE_AT,
      jobId: record.jobId,
      leaseSeconds: 60,
      ownerId: "worker_without_bundle",
      tenantId: record.tenantId,
    });
    expect(lease).not.toBeNull();
    const claimed = await repository.findByLease(lease!);
    expect(claimed).not.toBeNull();
    const at = new Date("2026-07-19T20:00:01.000Z");
    await expect(
      repository.completeLease(lease!, {
        ...claimed!,
        snapshot: {
          ...claimed!.snapshot,
          job: transitionJob(claimed!.snapshot.job, "SUCCEEDED", {
            at,
            progressPhase: "VERIFIED",
          }),
        },
        updatedAt: at.toISOString(),
      }),
    ).rejects.toMatchObject({ code: "INVALID_DURABLE_RECORD" });
  });

  it("rejects credential-shaped worker failures before persistence", async () => {
    const record = await seed("failure_redaction");
    const lease = await repository.claimLease({
      at: DURABLE_AT,
      jobId: record.jobId,
      leaseSeconds: 60,
      ownerId: "worker_failure_redaction",
      tenantId: record.tenantId,
    });
    const claimed = await repository.findByLease(lease!);
    const at = new Date("2026-07-19T20:00:01.000Z");
    await expect(
      repository.completeLease(lease!, {
        ...claimed!,
        snapshot: {
          ...claimed!.snapshot,
          job: transitionJob(claimed!.snapshot.job, "FAILED", {
            at,
            failure: {
              code: "PROVIDER_FAILURE",
              message: "Bearer synthetic-secret-that-must-never-persist",
              retryable: false,
            },
            progressPhase: "DRAFT",
          }),
        },
        updatedAt: at.toISOString(),
      }),
    ).rejects.toMatchObject({ code: "INVALID_DURABLE_RECORD" });
    const stored = await database.query<{ failure_message: string | null }>(
      "SELECT failure_message FROM jobs WHERE tenant_id = $1",
      [record.tenantId],
    );
    expect(stored.rows).toEqual([{ failure_message: null }]);
  });

  it("turns an exhausted expired lease into a sanitized terminal failure", async () => {
    const record = await seed("recover_exhausted");
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const at = new Date(Date.parse(DURABLE_AT) + (attempt - 1) * 120_000);
      const lease = await repository.claimLease({
        at: at.toISOString(),
        jobId: record.jobId,
        leaseSeconds: 60,
        ownerId: `worker_${attempt}`,
        tenantId: record.tenantId,
      });
      expect(lease?.attempt).toBe(attempt);
      const result = await repository.recoverExpiredLeases({
        at: new Date(at.getTime() + 61_000).toISOString(),
        limit: 10,
      });
      expect(result).toEqual(
        attempt < 3
          ? { cancelled: 0, exhausted: 0, requeued: 1 }
          : { cancelled: 0, exhausted: 1, requeued: 0 },
      );
    }

    const jobs = await database.query<{
      failure_code: string;
      failure_message: string;
      failure_retryable: boolean;
      lease_owner: string | null;
      state: string;
    }>(
      `SELECT state, lease_owner, failure_code, failure_message,
              failure_retryable
         FROM jobs WHERE tenant_id = $1`,
      [record.tenantId],
    );
    expect(jobs.rows).toEqual([
      {
        failure_code: "JOB_RETRY_EXHAUSTED",
        failure_message: "The durable worker exhausted its retry budget",
        failure_retryable: false,
        lease_owner: null,
        state: "FAILED",
      },
    ]);
    expect(JSON.stringify(jobs.rows)).not.toContain("VERIFIED");
  });
});
