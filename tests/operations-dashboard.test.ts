import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildOperationsDashboard } from "@/application/operations-dashboard";
import { PostgresOperationsDashboardSource } from "@/infrastructure/operations/postgres-operations-dashboard";
import { applyPostgresMigrations } from "@/infrastructure/postgres/migrations";

import { pgliteMigrationClient } from "./helpers/pglite-migration-client";
import { pglitePostgresDatabase } from "./helpers/pglite-postgres-database";

vi.setConfig({ testTimeout: 30_000 });

const databases: PGlite[] = [];

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

function durable(overrides: Record<string, unknown> = {}) {
  return {
    deletions: { failed: 0, pending: 0 },
    jobs: {
      cancelled: 0,
      expiredLeases: 0,
      failed: 0,
      oldestQueuedAgeSeconds: null,
      queued: 0,
      running: 0,
      succeeded: 0,
    },
    outbox: { dead: 0, oldestPendingAgeSeconds: null, pending: 0 },
    quarantinedResources: 0,
    ...overrides,
  };
}

describe("private-beta operations dashboard", () => {
  it("evaluates every owned alert against stable thresholds", () => {
    const dashboard = buildOperationsDashboard({
      at: "2026-07-20T23:10:00.000Z",
      durable: durable({
        deletions: { failed: 1, pending: 2 },
        jobs: {
          cancelled: 1,
          expiredLeases: 1,
          failed: 2,
          oldestQueuedAgeSeconds: 301,
          queued: 3,
          running: 1,
          succeeded: 4,
        },
        outbox: { dead: 1, oldestPendingAgeSeconds: 240, pending: 2 },
        quarantinedResources: 1,
      }),
      features: {
        disablePrivateRepositories: true,
        disableRepositoryStarts: false,
        disabledExecutionProfiles: ["node24"],
      },
      health: { readiness: "unavailable", runner: "unavailable" },
    });

    expect(dashboard.schemaVersion).toBe("1.0");
    expect(dashboard.features).toEqual({
      privateRepositories: "disabled",
      repositoryStarts: "enabled",
      node22: "enabled",
      node24: "disabled",
    });
    expect(dashboard.alerts).toHaveLength(8);
    expect(dashboard.alerts.every(({ owner, runbook, testProcedure }) =>
      owner === "platform-on-call" &&
      runbook.startsWith("docs/operations.md#") &&
      testProcedure.length > 0,
    )).toBe(true);
    expect(dashboard.alerts.filter(({ status }) => status === "firing")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "DEPENDENCY_READINESS_UNAVAILABLE" }),
        expect.objectContaining({ code: "RUNNER_UNAVAILABLE" }),
        expect.objectContaining({ code: "QUEUED_JOB_AGE_HIGH" }),
        expect.objectContaining({ code: "OUTBOX_LAG_HIGH" }),
        expect.objectContaining({ code: "EXPIRED_LEASES_PRESENT" }),
        expect.objectContaining({ code: "OUTBOX_DEAD_PRESENT" }),
        expect.objectContaining({ code: "DELETION_FAILURE_PRESENT" }),
        expect.objectContaining({ code: "SANDBOX_QUARANTINE_PRESENT" }),
      ]),
    );
  });

  it("reads only aggregate durable signals from Postgres", async () => {
    const database = new PGlite();
    databases.push(database);
    await applyPostgresMigrations(pgliteMigrationClient(database));
    const postgres = pglitePostgresDatabase(database);
    await postgres.query(
      `INSERT INTO tenants (id, created_at, updated_at)
       VALUES ('tenant_dashboard', '2026-07-20T22:00:00.000Z', '2026-07-20T22:00:00.000Z')`,
    );
    await postgres.query(
      `INSERT INTO cases (
         tenant_id, id, source_kind, source_descriptor, created_at, updated_at
       ) VALUES (
         'tenant_dashboard', 'case_dashboard', 'github', '{}'::jsonb,
         '2026-07-20T22:00:00.000Z', '2026-07-20T22:00:00.000Z'
       )`,
    );
    await postgres.query(
      `INSERT INTO jobs (
         tenant_id, id, case_id, state, progress_phase, attempt, max_attempts,
         next_attempt_at, lease_owner, lease_acquired_at, lease_expires_at,
         created_at, updated_at
       ) VALUES (
         'tenant_dashboard', 'job_dashboard', 'case_dashboard', 'RUNNING',
         'EXPERIMENTING', 1, 3, '2026-07-20T22:00:00.000Z',
         'worker_dashboard', '2026-07-20T22:00:00.000Z',
         '2026-07-20T22:05:00.000Z', '2026-07-20T22:00:00.000Z',
         '2026-07-20T22:00:00.000Z'
       )`,
    );
    await postgres.query(
      `INSERT INTO outbox_events (
         tenant_id, id, case_id, job_id, kind, payload, status,
         delivery_count, next_attempt_at, last_error_code, created_at, updated_at
       ) VALUES (
         'tenant_dashboard', 'event_dashboard', 'case_dashboard',
         'job_dashboard', 'reproduction.requested',
         '{"caseId":"case_dashboard","eventId":"event_dashboard","jobId":"job_dashboard","kind":"reproduction.requested","schemaVersion":"1.0","tenantId":"tenant_dashboard"}'::jsonb,
         'DEAD', 5, '2026-07-20T22:00:00.000Z', 'QUEUE_PUBLISH_FAILED',
         '2026-07-20T22:00:00.000Z', '2026-07-20T22:00:00.000Z'
       )`,
    );
    await postgres.query(
      `INSERT INTO deletion_requests (
         tenant_id, id, requested_by, state, failure_code, created_at, updated_at
       ) VALUES (
         'tenant_dashboard', 'delete_dashboard', 'principal_dashboard',
         'FAILED', 'BLOB_DELETE_FAILED', '2026-07-20T22:00:00.000Z',
         '2026-07-20T22:00:00.000Z'
       )`,
    );
    await postgres.query(
      `INSERT INTO audit_events (
         tenant_id, id, actor_id, action, target_type, target_id, outcome,
         metadata, occurred_at
       ) VALUES (
         'tenant_dashboard', 'audit_dashboard', 'system',
         'sandbox.cleanup-quarantined', 'job', 'job_dashboard.attempt-1',
         'failure', '{"cleanupKind":"sandbox","providerId":"sbx_dashboard"}'::jsonb,
         '2026-07-20T22:00:00.000Z'
       )`,
    );

    const source = new PostgresOperationsDashboardSource(postgres);
    await expect(
      source.read({ at: "2026-07-20T23:10:00.000Z" }),
    ).resolves.toEqual({
      deletions: { failed: 1, pending: 0 },
      jobs: {
        cancelled: 0,
        expiredLeases: 1,
        failed: 0,
        oldestQueuedAgeSeconds: null,
        queued: 0,
        running: 1,
        succeeded: 0,
      },
      outbox: { dead: 1, oldestPendingAgeSeconds: null, pending: 0 },
      quarantinedResources: 1,
    });
    expect(JSON.stringify(await source.read({ at: "2026-07-20T23:10:00.000Z" })))
      .not.toMatch(/tenant_dashboard|case_dashboard|job_dashboard|sbx_dashboard/);
  });
});
