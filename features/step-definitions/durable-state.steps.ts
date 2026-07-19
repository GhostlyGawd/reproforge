import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { PGlite } from "@electric-sql/pglite";
import { After, Given, Then, When } from "@cucumber/cucumber";

import {
  DurableStartError,
  reserveDurableStart,
  type DurableStartInput,
} from "@/application/durable-start";
import { DurableQueueConsumer } from "@/application/durable-queue-consumer";
import { requestDurableCancellation } from "@/application/durable-cancellation";
import type { DurableReproductionRecord } from "@/application/ports/production";
import { createCase, transitionCase } from "@/domain/case";
import { createJob, transitionJob } from "@/domain/job";
import { ContentAddressedArtifactStore } from "@/infrastructure/artifacts/content-addressed-store";
import { applyPostgresMigrations } from "@/infrastructure/postgres/migrations";
import {
  PostgresDurableReproductionRepository,
  PostgresUnitOfWork,
} from "@/infrastructure/postgres/repositories";
import { PostgresTenantDataRetention } from "@/infrastructure/retention/postgres-tenant-data-retention";
import { pgliteMigrationClient } from "../../tests/helpers/pglite-migration-client";
import { pglitePostgresDatabase } from "../../tests/helpers/pglite-postgres-database";
import { MemoryPrivateBlobClient } from "../../tests/helpers/memory-private-blob-client";
import { createRuntimeHealthService } from "@/infrastructure/operations/runtime-health";
import {
  InMemoryOperationalMetrics,
  JsonOperationalLogger,
} from "@/infrastructure/operations/observability";
import type { ReproForgeWorld } from "../support/world";

const AT = "2026-07-19T20:00:00.000Z";

function bddRecord(
  overrides: Partial<DurableReproductionRecord> = {},
): DurableReproductionRecord {
  const caseId = overrides.caseId ?? "case_bdd_durable";
  const jobId = overrides.jobId ?? "job_bdd_durable";
  const at = new Date(AT);
  return {
    callerId: "caller_bdd_durable",
    caseId,
    commandHash: "a".repeat(64),
    createdAt: AT,
    idempotencyKey: "key_bdd_durable",
    jobId,
    snapshot: {
      case: createCase(caseId, at),
      job: createJob(jobId, caseId, at),
      result: null,
      sampleId: "cli-spaces",
      schemaVersion: "2.0",
    },
    tenantId: "tenant_bdd_durable",
    updatedAt: AT,
    version: 1,
    ...overrides,
  };
}

function bddStartInput(record: DurableReproductionRecord): DurableStartInput {
  return {
    auditEvent: {
      action: "case.created",
      actorId: record.callerId,
      eventId: `audit_${record.caseId}`,
      metadata: { sampleKind: "trusted-sample" },
      occurredAt: AT,
      outcome: "success",
      targetId: record.caseId,
      targetType: "case",
      tenantId: record.tenantId,
    },
    outboxMessage: {
      caseId: record.caseId,
      eventId: `outbox_${record.caseId}`,
      jobId: record.jobId,
      kind: "reproduction.requested",
      schemaVersion: "1.0",
      tenantId: record.tenantId,
    },
    quotaReservation: {
      amount: 1,
      caseId: record.caseId,
      expiresAt: "2026-07-20T20:00:00.000Z",
      jobId: record.jobId,
      reservationId: `quota_${record.caseId}`,
      resource: "active-jobs",
      tenantId: record.tenantId,
    },
    record,
  };
}

After(async function (this: ReproForgeWorld) {
  if (this.durableDatabase) await this.durableDatabase.close();
});

Given(
  "an empty durable Postgres store for a tenant",
  { timeout: 30_000 },
  async function (this: ReproForgeWorld) {
    this.durableDatabase = new PGlite();
    await applyPostgresMigrations(
      pgliteMigrationClient(this.durableDatabase),
    );
    this.durablePostgres = pglitePostgresDatabase(this.durableDatabase);
    this.durableRepository = new PostgresDurableReproductionRepository(
      this.durablePostgres,
    );
    this.durableUnitOfWork = new PostgresUnitOfWork(this.durablePostgres);
    this.durableRecord = bddRecord();
    this.durableStarts = [];
    this.durableErrorCode = undefined;
    this.durableQueueExecutions = 0;
    this.durableQueueOutcomes = [];
    this.durableRecoverySummaries = [];
    await this.durableDatabase.query("INSERT INTO tenants (id) VALUES ($1)", [
      this.durableRecord.tenantId,
    ]);
  },
);

When(
  "the caller reserves a durable reproduction",
  async function (this: ReproForgeWorld) {
    assert(this.durableUnitOfWork);
    assert(this.durableRecord);
    this.durableStarts.push(
      await reserveDurableStart(
        this.durableUnitOfWork,
        bddStartInput(this.durableRecord),
      ),
    );
  },
);

When(
  "the application repository adapter is recreated",
  function (this: ReproForgeWorld) {
    assert(this.durablePostgres);
    this.durableRepository = new PostgresDurableReproductionRepository(
      this.durablePostgres,
    );
    this.durableUnitOfWork = new PostgresUnitOfWork(this.durablePostgres);
  },
);

When(
  "the caller retries the same durable start",
  async function (this: ReproForgeWorld) {
    assert(this.durableUnitOfWork);
    assert(this.durableRecord);
    this.durableStarts.push(
      await reserveDurableStart(
        this.durableUnitOfWork,
        bddStartInput(this.durableRecord),
      ),
    );
  },
);

When(
  "the caller retries the durable key with changed input",
  async function (this: ReproForgeWorld) {
    assert(this.durableUnitOfWork);
    assert(this.durableRecord);
    const conflicting = bddRecord({
      caseId: "case_bdd_conflicting",
      commandHash: "b".repeat(64),
      idempotencyKey: this.durableRecord.idempotencyKey,
      jobId: "job_bdd_conflicting",
    });
    try {
      await reserveDurableStart(
        this.durableUnitOfWork,
        bddStartInput(conflicting),
      );
    } catch (error) {
      this.durableErrorCode =
        error instanceof DurableStartError ? error.code : "UNEXPECTED_ERROR";
    }
  },
);

When(
  "another tenant reads the durable case",
  async function (this: ReproForgeWorld) {
    assert(this.durableRepository);
    assert(this.durableRecord);
    this.durableRead = await this.durableRepository.findByCaseId(
      {
        callerId: this.durableRecord.callerId,
        principalId: this.durableRecord.callerId,
        tenantId: "tenant_bdd_other",
      },
      this.durableRecord.caseId,
    );
  },
);

Then(
  "the durable case and job remain readable",
  async function (this: ReproForgeWorld) {
    assert(this.durableRepository);
    assert(this.durableRecord);
    const stored = await this.durableRepository.findByCaseId(
      {
        callerId: this.durableRecord.callerId,
        principalId: this.durableRecord.callerId,
        tenantId: this.durableRecord.tenantId,
      },
      this.durableRecord.caseId,
    );
    assert.equal(stored?.caseId, this.durableRecord.caseId);
    assert.equal(stored?.jobId, this.durableRecord.jobId);
  },
);

Given(
  "a private bundle artifact for the durable case",
  async function (this: ReproForgeWorld) {
    assert(this.durableUnitOfWork);
    assert(this.durableRecord);
    assert(this.durablePostgres);
    this.durableStarts.push(
      await reserveDurableStart(
        this.durableUnitOfWork,
        bddStartInput(this.durableRecord),
      ),
    );
    const bytes = new TextEncoder().encode("bdd private bundle");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    this.durableArtifactDescriptor = {
      artifactId: "artifact_bdd_private",
      byteCount: bytes.byteLength,
      caseId: this.durableRecord.caseId,
      createdAt: AT,
      kind: "bundle",
      objectKey: `tenants/${this.durableRecord.tenantId}/cases/${this.durableRecord.caseId}/bundle/${sha256}`,
      retentionUntil: "2026-08-19T20:00:00.000Z",
      sha256,
      tenantId: this.durableRecord.tenantId,
    };
    this.durableBlobClient = new MemoryPrivateBlobClient();
    this.durableArtifactStore = new ContentAddressedArtifactStore(
      this.durablePostgres,
      this.durableBlobClient,
      { now: () => new Date(AT) },
    );
    await this.durableArtifactStore.put({
      bytes,
      descriptor: this.durableArtifactDescriptor,
    });
  },
);

When(
  "another tenant reads the private artifact",
  async function (this: ReproForgeWorld) {
    assert(this.durableArtifactStore);
    assert(this.durableArtifactDescriptor);
    assert(this.durableRecord);
    this.durableArtifactRead = await this.durableArtifactStore.read(
      {
        callerId: this.durableRecord.callerId,
        principalId: this.durableRecord.callerId,
        tenantId: "tenant_bdd_other",
      },
      this.durableArtifactDescriptor.artifactId,
    );
  },
);

When(
  "the owner deletes the private artifact",
  async function (this: ReproForgeWorld) {
    assert(this.durableArtifactStore);
    assert(this.durableArtifactDescriptor);
    assert(this.durableRecord);
    const owner = {
      callerId: this.durableRecord.callerId,
      principalId: this.durableRecord.callerId,
      tenantId: this.durableRecord.tenantId,
    };
    assert.equal(
      await this.durableArtifactStore.delete(
        owner,
        this.durableArtifactDescriptor.artifactId,
      ),
      true,
    );
    this.durableArtifactRead = await this.durableArtifactStore.read(
      owner,
      this.durableArtifactDescriptor.artifactId,
    );
  },
);

Then(
  "the cross-tenant artifact read returns not found before provider access",
  function (this: ReproForgeWorld) {
    assert.equal(this.durableArtifactRead, null);
    assert.deepEqual(this.durableBlobClient?.gets, []);
  },
);

Then(
  "the private artifact is no longer readable",
  function (this: ReproForgeWorld) {
    assert.equal(this.durableArtifactRead, null);
    assert.equal(
      this.durableBlobClient?.has(
        this.durableArtifactDescriptor?.objectKey ?? "missing",
      ),
      false,
    );
  },
);

When(
  "the same queued job is delivered twice",
  async function (this: ReproForgeWorld) {
    assert(this.durableRepository);
    assert(this.durableRecord);
    const consumer = new DurableQueueConsumer({
      clock: { now: () => new Date(AT) },
      leaseSeconds: 60,
      repository: this.durableRepository,
      worker: {
        execute: async ({ record }) => {
          this.durableQueueExecutions += 1;
          const completedAt = new Date("2026-07-19T20:00:01.000Z");
          const blockedCase = transitionCase(
            transitionCase(
              record.snapshot.case,
              "INGESTING",
              "BDD worker started",
              completedAt,
            ),
            "BLOCKED",
            "BDD terminal completion",
            new Date("2026-07-19T20:00:02.000Z"),
          );
          return {
            ...record,
            snapshot: {
              ...record.snapshot,
              case: blockedCase,
              job: transitionJob(record.snapshot.job, "FAILED", {
                at: new Date("2026-07-19T20:00:02.000Z"),
                failure: {
                  code: "BDD_TERMINAL",
                  message: "The BDD worker stopped safely",
                  retryable: false,
                },
                progressPhase: "BLOCKED",
              }),
            },
            updatedAt: "2026-07-19T20:00:02.000Z",
          };
        },
      },
    });
    const message = bddStartInput(this.durableRecord).outboxMessage;
    for (const ownerId of ["worker_bdd_first", "worker_bdd_duplicate"]) {
      const result = await consumer.consume(message, ownerId);
      this.durableQueueOutcomes.push(result.outcome);
    }
  },
);

Then(
  "exactly one durable attempt completes",
  async function (this: ReproForgeWorld) {
    assert(this.durableRepository);
    assert(this.durableRecord);
    assert.equal(this.durableQueueExecutions, 1);
    assert.deepEqual(this.durableQueueOutcomes, ["completed", "ignored"]);
    const stored = await this.durableRepository.findByCaseId(
      {
        callerId: this.durableRecord.callerId,
        principalId: this.durableRecord.callerId,
        tenantId: this.durableRecord.tenantId,
      },
      this.durableRecord.caseId,
    );
    assert.equal(stored?.snapshot.job.attempt, 1);
    assert.equal(stored?.snapshot.job.state, "FAILED");
  },
);

When(
  "the caller cancels the queued durable job",
  async function (this: ReproForgeWorld) {
    assert(this.durableUnitOfWork);
    assert(this.durableRecord);
    const result = await requestDurableCancellation(this.durableUnitOfWork, {
      at: AT,
      jobId: this.durableRecord.jobId,
      scope: {
        callerId: this.durableRecord.callerId,
        principalId: this.durableRecord.callerId,
        tenantId: this.durableRecord.tenantId,
      },
    });
    assert.deepEqual(result, {
      accepted: true,
      changed: true,
      disposition: "cancelled",
    });
  },
);

When(
  "the cancelled durable job is delivered",
  async function (this: ReproForgeWorld) {
    assert(this.durableRepository);
    assert(this.durableRecord);
    const consumer = new DurableQueueConsumer({
      clock: { now: () => new Date(AT) },
      leaseSeconds: 60,
      repository: this.durableRepository,
      worker: {
        execute: async ({ record }) => {
          this.durableQueueExecutions += 1;
          return record;
        },
      },
    });
    const result = await consumer.consume(
      bddStartInput(this.durableRecord).outboxMessage,
      "worker_bdd_cancelled",
    );
    this.durableQueueOutcomes.push(result.outcome);
  },
);

Then("no durable attempt starts", async function (this: ReproForgeWorld) {
  assert(this.durableDatabase);
  assert(this.durableRecord);
  assert.equal(this.durableQueueExecutions, 0);
  assert.deepEqual(this.durableQueueOutcomes, ["ignored"]);
  const rows = await this.durableDatabase.query<{
    attempt: number;
    quota_state: string;
    state: string;
  }>(
    `SELECT j.attempt, j.state, q.state AS quota_state
       FROM jobs j
       JOIN quota_ledger q
         ON q.tenant_id = j.tenant_id AND q.job_id = j.id
      WHERE j.tenant_id = $1 AND j.id = $2`,
    [this.durableRecord.tenantId, this.durableRecord.jobId],
  );
  assert.deepEqual(rows.rows, [
    { attempt: 0, quota_state: "RELEASED", state: "CANCELLED" },
  ]);
});

Given(
  "an expired tenant with a private durable artifact",
  { timeout: 30_000 },
  async function (this: ReproForgeWorld) {
    this.durableDatabase = new PGlite();
    await applyPostgresMigrations(pgliteMigrationClient(this.durableDatabase));
    this.durablePostgres = pglitePostgresDatabase(this.durableDatabase);
    this.durableRepository = new PostgresDurableReproductionRepository(
      this.durablePostgres,
    );
    this.durableUnitOfWork = new PostgresUnitOfWork(this.durablePostgres);
    this.durableRecord = bddRecord({
      caseId: "case_bdd_retention",
      idempotencyKey: "key_bdd_retention",
      jobId: "job_bdd_retention",
      tenantId: "tenant_bdd_retention",
    });
    await this.durableDatabase.query(
      `INSERT INTO tenants (
         id, created_at, updated_at, retention_until
       ) VALUES ($1, '2026-07-19T19:00:00.000Z',
                    '2026-07-20T20:00:00.000Z',
                    '2026-07-20T20:00:00.000Z')`,
      [this.durableRecord.tenantId],
    );
    await reserveDurableStart(
      this.durableUnitOfWork,
      bddStartInput(this.durableRecord),
    );
    const bytes = new TextEncoder().encode("bdd retention artifact");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    this.durableArtifactDescriptor = {
      artifactId: "artifact_bdd_retention",
      byteCount: bytes.byteLength,
      caseId: this.durableRecord.caseId,
      createdAt: AT,
      kind: "bundle",
      objectKey: `tenants/${this.durableRecord.tenantId}/cases/${this.durableRecord.caseId}/bundle/${sha256}`,
      retentionUntil: "2026-08-19T20:00:00.000Z",
      sha256,
      tenantId: this.durableRecord.tenantId,
    };
    this.durableBlobClient = new MemoryPrivateBlobClient();
    this.durableArtifactStore = new ContentAddressedArtifactStore(
      this.durablePostgres,
      this.durableBlobClient,
      { now: () => new Date(AT) },
    );
    await this.durableArtifactStore.put({
      bytes,
      descriptor: this.durableArtifactDescriptor,
    });
    this.durableRetention = new PostgresTenantDataRetention(
      this.durablePostgres,
      this.durableBlobClient,
    );
  },
);

When(
  "the retention deletion worker runs",
  async function (this: ReproForgeWorld) {
    assert(this.durableRetention);
    const at = "2026-07-22T20:00:00.000Z";
    assert.equal(
      (await this.durableRetention.scheduleDue({ at, limit: 1 })).length,
      1,
    );
    this.durableRetentionResult = await this.durableRetention.executeNext({ at });
  },
);

Then(
  "all retained customer data is removed",
  async function (this: ReproForgeWorld) {
    assert(this.durableDatabase);
    assert(this.durableRecord);
    assert(this.durableArtifactDescriptor);
    const counts = await this.durableDatabase.query<{
      artifacts: string;
      cases: string;
      jobs: string;
      requests: string;
    }>(
      `SELECT
         (SELECT count(*) FROM artifacts WHERE tenant_id = $1)::text AS artifacts,
         (SELECT count(*) FROM cases WHERE tenant_id = $1)::text AS cases,
         (SELECT count(*) FROM jobs WHERE tenant_id = $1)::text AS jobs,
         (SELECT count(*) FROM deletion_requests WHERE tenant_id = $1)::text AS requests`,
      [this.durableRecord.tenantId],
    );
    assert.deepEqual(counts.rows[0], {
      artifacts: "0",
      cases: "0",
      jobs: "0",
      requests: "0",
    });
    assert.equal(
      this.durableBlobClient?.has(this.durableArtifactDescriptor.objectKey),
      false,
    );
  },
);

Then(
  "exactly one sanitized deletion audit tombstone remains",
  async function (this: ReproForgeWorld) {
    assert(this.durableDatabase);
    assert(this.durableRecord);
    assert(this.durableRetentionResult);
    const rows = await this.durableDatabase.query<{
      action: string;
      actor_id: string;
      metadata: unknown;
      outcome: string;
    }>(
      `SELECT action, actor_id, metadata, outcome
         FROM audit_events WHERE tenant_id = $1`,
      [this.durableRecord.tenantId],
    );
    assert.deepEqual(rows.rows, [
      {
        action: "account.deleted",
        actor_id: "system_retention",
        metadata: { reason: "retention" },
        outcome: "success",
      },
    ]);
  },
);

When(
  "a worker lease expires and recovery runs twice",
  async function (this: ReproForgeWorld) {
    assert(this.durableRepository);
    assert(this.durableRecord);
    const lease = await this.durableRepository.claimLease({
      at: AT,
      jobId: this.durableRecord.jobId,
      leaseSeconds: 60,
      ownerId: "worker_bdd_crashed",
      tenantId: this.durableRecord.tenantId,
    });
    assert(lease);
    for (let index = 0; index < 2; index += 1) {
      this.durableRecoverySummaries.push(
        await this.durableRepository.recoverExpiredLeases({
          at: "2026-07-19T20:02:00.000Z",
          limit: 10,
        }),
      );
    }
  },
);

Then(
  "exactly one recovery intent requeues the durable job",
  async function (this: ReproForgeWorld) {
    assert(this.durableDatabase);
    assert(this.durableRecord);
    assert.deepEqual(this.durableRecoverySummaries, [
      { cancelled: 0, exhausted: 0, requeued: 1 },
      { cancelled: 0, exhausted: 0, requeued: 0 },
    ]);
    const jobs = await this.durableDatabase.query<{
      attempt: number;
      state: string;
    }>("SELECT state, attempt FROM jobs WHERE tenant_id = $1", [
      this.durableRecord.tenantId,
    ]);
    const events = await this.durableDatabase.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM outbox_events
        WHERE tenant_id = $1
          AND kind = 'reproduction.recovery-requested'`,
      [this.durableRecord.tenantId],
    );
    assert.deepEqual(jobs.rows, [{ attempt: 1, state: "QUEUED" }]);
    assert.equal(events.rows[0]?.count, "1");
  },
);

Then(
  "exactly one durable case and job exist",
  async function (this: ReproForgeWorld) {
    assert(this.durableDatabase);
    assert(this.durableRecord);
    const counts = await this.durableDatabase.query<{
      cases: string;
      jobs: string;
    }>(
      `SELECT
         (SELECT count(*) FROM cases WHERE tenant_id = $1)::text AS cases,
         (SELECT count(*) FROM jobs WHERE tenant_id = $1)::text AS jobs`,
      [this.durableRecord.tenantId],
    );
    assert.deepEqual(counts.rows[0], { cases: "1", jobs: "1" });
  },
);

Then(
  "the retry returns the original durable case and job",
  function (this: ReproForgeWorld) {
    assert.equal(this.durableStarts.length, 2);
    assert.equal(this.durableStarts[0]?.created, true);
    assert.equal(this.durableStarts[1]?.created, false);
    assert.equal(
      this.durableStarts[0]?.record.caseId,
      this.durableStarts[1]?.record.caseId,
    );
    assert.equal(
      this.durableStarts[0]?.record.jobId,
      this.durableStarts[1]?.record.jobId,
    );
  },
);

Then(
  "the durable start error code is {string}",
  function (this: ReproForgeWorld, code: string) {
    assert.equal(this.durableErrorCode, code);
  },
);

Then(
  "the cross-tenant durable read returns not found",
  function (this: ReproForgeWorld) {
    assert.equal(this.durableRead, null);
  },
);

Given(
  "a hosted runtime with incomplete production configuration",
  function (this: ReproForgeWorld) {
    this.runtimeHealthService = createRuntimeHealthService({
      clock: { now: () => new Date(AT) },
      environment: {
        REPROFORGE_RUNTIME_MODE: "production",
        REPROFORGE_BASE_URL: "https://reproforge.example",
      },
      logger: new JsonOperationalLogger({
        sink: { error: () => undefined, info: () => undefined },
      }),
      metrics: new InMemoryOperationalMetrics(),
    });
  },
);

When(
  "dependency readiness is checked",
  async function (this: ReproForgeWorld) {
    assert(this.runtimeHealthService);
    this.runtimeHealthReport = await this.runtimeHealthService.readiness();
  },
);

Then(
  "readiness fails with {string}",
  function (this: ReproForgeWorld, code: string) {
    assert(this.runtimeHealthReport);
    assert.equal(this.runtimeHealthReport.status, "unavailable");
    assert.equal(this.runtimeHealthReport.checks.length, 1);
    const [check] = this.runtimeHealthReport.checks;
    assert(check);
    assert.equal(check.code, code);
    assert.equal(check.component, "configuration");
    assert.equal(check.status, "unavailable");
    assert(check.durationMs >= 0);
  },
);

Then(
  "no local provider fallback is reported",
  function (this: ReproForgeWorld) {
    assert(this.runtimeHealthReport);
    assert.equal(
      this.runtimeHealthReport.checks.some(({ code }) =>
        code.startsWith("LOCAL_"),
      ),
      false,
    );
  },
);
