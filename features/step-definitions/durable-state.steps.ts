import assert from "node:assert/strict";

import { PGlite } from "@electric-sql/pglite";
import { After, Given, Then, When } from "@cucumber/cucumber";

import {
  DurableStartError,
  reserveDurableStart,
  type DurableStartInput,
} from "@/application/durable-start";
import type { DurableReproductionRecord } from "@/application/ports/production";
import { createCase } from "@/domain/case";
import { createJob } from "@/domain/job";
import { applyPostgresMigrations } from "@/infrastructure/postgres/migrations";
import {
  PostgresDurableReproductionRepository,
  PostgresUnitOfWork,
} from "@/infrastructure/postgres/repositories";
import { pgliteMigrationClient } from "../../tests/helpers/pglite-migration-client";
import { pglitePostgresDatabase } from "../../tests/helpers/pglite-postgres-database";
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
      expiresAt: "2026-07-20T20:00:00.000Z",
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
