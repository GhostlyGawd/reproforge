import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  DurableStartError,
  reserveDurableStart,
  type DurableStartInput,
} from "@/application/durable-start";
import type {
  DurableReproductionRecord,
  TenantScope,
} from "@/application/ports/production";
import { createCase } from "@/domain/case";
import { createJob } from "@/domain/job";
import { pglitePostgresDatabase } from "./helpers/pglite-postgres-database";
import { pgliteMigrationClient } from "./helpers/pglite-migration-client";
import { databaseClockAt } from "./helpers/database-clock";
import { applyPostgresMigrations } from "@/infrastructure/postgres/migrations";
import {
  OptimisticConcurrencyError,
  PostgresDurableReproductionRepository,
  PostgresUnitOfWork,
} from "@/infrastructure/postgres/repositories";

vi.setConfig({ hookTimeout: 30_000, testTimeout: 30_000 });

const AT = "2026-07-19T20:00:00.000Z";
const LATER = "2026-07-19T20:01:00.000Z";

let database: PGlite;
let postgres: ReturnType<typeof pglitePostgresDatabase>;
let repository: PostgresDurableReproductionRepository;
let unitOfWork: PostgresUnitOfWork;

function scope(
  tenantId: string,
  callerId = "caller_main",
): TenantScope {
  return { callerId, principalId: callerId, tenantId };
}

function record(input: {
  callerId?: string;
  caseId?: string;
  commandHash?: string;
  idempotencyKey?: string;
  jobId?: string;
  tenantId: string;
}): DurableReproductionRecord {
  const callerId = input.callerId ?? "caller_main";
  const caseId = input.caseId ?? `case_${input.tenantId}`;
  const jobId = input.jobId ?? `job_${input.tenantId}`;
  const createdAt = new Date(AT);
  return {
    callerId,
    caseId,
    commandHash: input.commandHash ?? "a".repeat(64),
    createdAt: AT,
    idempotencyKey: input.idempotencyKey ?? "start_main",
    jobId,
    snapshot: {
      case: createCase(caseId, createdAt),
      job: createJob(jobId, caseId, createdAt),
      result: null,
      sampleId: "cli-spaces",
      schemaVersion: "2.0",
    },
    tenantId: input.tenantId,
    updatedAt: AT,
    version: 1,
  };
}

function startInput(value: DurableReproductionRecord): DurableStartInput {
  return {
    auditEvent: {
      action: "case.created",
      actorId: value.callerId,
      eventId: `audit_${value.caseId}`,
      metadata: { sampleKind: "trusted-sample" },
      occurredAt: AT,
      outcome: "success",
      targetId: value.caseId,
      targetType: "case",
      tenantId: value.tenantId,
    },
    outboxMessage: {
      caseId: value.caseId,
      eventId: `outbox_${value.caseId}`,
      jobId: value.jobId,
      kind: "reproduction.requested",
      schemaVersion: "1.0",
      tenantId: value.tenantId,
    },
    quotaReservation: {
      amount: 1,
      caseId: value.caseId,
      expiresAt: databaseClockAt(10 * 60 * 1_000),
      jobId: value.jobId,
      reservationId: `quota_${value.caseId}`,
      resource: "active-jobs",
      tenantId: value.tenantId,
    },
    record: value,
  };
}

async function seedTenant(tenantId: string): Promise<void> {
  await database.query("INSERT INTO tenants (id) VALUES ($1)", [tenantId]);
}

async function tableCount(table: string, tenantId: string): Promise<number> {
  const allowed = new Set([
    "audit_events",
    "cases",
    "idempotency_keys",
    "jobs",
    "outbox_events",
    "quota_ledger",
  ]);
  if (!allowed.has(table)) throw new Error("unexpected test table");
  const result = await database.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM ${table} WHERE tenant_id = $1`,
    [tenantId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

beforeAll(async () => {
  database = new PGlite();
  await applyPostgresMigrations(pgliteMigrationClient(database));
  postgres = pglitePostgresDatabase(database);
  repository = new PostgresDurableReproductionRepository(postgres);
  unitOfWork = new PostgresUnitOfWork(postgres);
});

afterAll(async () => {
  await database.close();
});

describe("Postgres durable repositories", () => {
  it("atomically creates one case, job, key, quota, audit, and outbox intent", async () => {
    const tenantId = "tenant_atomic";
    await seedTenant(tenantId);
    const expected = record({ tenantId });

    const result = await reserveDurableStart(unitOfWork, startInput(expected));

    expect(result).toEqual({ created: true, record: expected });
    await expect(
      repository.findByCaseId(scope(tenantId), expected.caseId),
    ).resolves.toEqual(expected);
    for (const table of [
      "cases",
      "jobs",
      "idempotency_keys",
      "quota_ledger",
      "audit_events",
      "outbox_events",
    ]) {
      await expect(tableCount(table, tenantId), table).resolves.toBe(1);
    }
  });

  it("returns the original record for an exact retry without duplicate side effects", async () => {
    const tenantId = "tenant_retry";
    await seedTenant(tenantId);
    const expected = record({ tenantId });
    const input = startInput(expected);

    await expect(reserveDurableStart(unitOfWork, input)).resolves.toMatchObject({
      created: true,
    });
    await expect(reserveDurableStart(unitOfWork, input)).resolves.toEqual({
      created: false,
      record: expected,
    });
    await expect(tableCount("cases", tenantId)).resolves.toBe(1);
    await expect(tableCount("quota_ledger", tenantId)).resolves.toBe(1);
    await expect(tableCount("audit_events", tenantId)).resolves.toBe(1);
    await expect(tableCount("outbox_events", tenantId)).resolves.toBe(1);
  });

  it("rejects conflicting input without mutating the original reservation", async () => {
    const tenantId = "tenant_conflict";
    await seedTenant(tenantId);
    const original = record({ tenantId });
    await reserveDurableStart(unitOfWork, startInput(original));
    const conflict = record({
      caseId: "case_conflicting",
      commandHash: "b".repeat(64),
      idempotencyKey: original.idempotencyKey,
      jobId: "job_conflicting",
      tenantId,
    });

    await expect(
      reserveDurableStart(unitOfWork, startInput(conflict)),
    ).rejects.toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
    } satisfies Partial<DurableStartError>);
    await expect(
      repository.findByIdempotencyKey(scope(tenantId), original.idempotencyKey),
    ).resolves.toEqual(original);
    await expect(tableCount("cases", tenantId)).resolves.toBe(1);
    await expect(tableCount("jobs", tenantId)).resolves.toBe(1);
  });

  it("rolls back every write when a transaction callback fails", async () => {
    const tenantId = "tenant_rollback";
    await seedTenant(tenantId);
    const candidate = record({ tenantId });

    await expect(
      unitOfWork.run(async (ports) => {
        await ports.reproductions.reserve(candidate);
        await ports.audit.append(startInput(candidate).auditEvent);
        throw new Error("synthetic rollback");
      }),
    ).rejects.toThrow("synthetic rollback");

    await expect(
      repository.findByCaseId(scope(tenantId), candidate.caseId),
    ).resolves.toBeNull();
    await expect(tableCount("cases", tenantId)).resolves.toBe(0);
    await expect(tableCount("audit_events", tenantId)).resolves.toBe(0);
  });

  it("rolls back the case and side effects when quota cannot be reserved", async () => {
    const tenantId = "tenant_quota_rollback";
    await seedTenant(tenantId);
    const candidate = record({ tenantId });
    const input = startInput(candidate);
    await database.query(
      `INSERT INTO quota_ledger (
         tenant_id, id, resource, window_start, window_end,
         reserved_amount, expires_at
       ) VALUES ($1, $2, 'active-jobs', CURRENT_TIMESTAMP, $3, 1, $3)`,
      [
        tenantId,
        input.quotaReservation.reservationId,
        input.quotaReservation.expiresAt,
      ],
    );

    await expect(
      reserveDurableStart(unitOfWork, input),
    ).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
    await expect(tableCount("cases", tenantId)).resolves.toBe(0);
    await expect(tableCount("jobs", tenantId)).resolves.toBe(0);
    await expect(tableCount("audit_events", tenantId)).resolves.toBe(0);
    await expect(tableCount("outbox_events", tenantId)).resolves.toBe(0);
    await expect(tableCount("quota_ledger", tenantId)).resolves.toBe(1);
  });

  it("never returns one tenant's record through another tenant scope", async () => {
    const tenantA = "tenant_scope_a";
    const tenantB = "tenant_scope_b";
    await seedTenant(tenantA);
    await seedTenant(tenantB);
    const first = record({ tenantId: tenantA });
    const second = record({
      commandHash: "b".repeat(64),
      tenantId: tenantB,
    });
    await repository.reserve(first);
    await repository.reserve(second);

    await expect(
      repository.findByCaseId(scope(tenantB), first.caseId),
    ).resolves.toBeNull();
    await expect(
      repository.findByCaseId(scope(tenantA), first.caseId),
    ).resolves.toEqual(first);
    await expect(
      repository.findByCaseId(scope(tenantB), second.caseId),
    ).resolves.toEqual(second);
  });

  it("uses compare-and-swap and leaves a stale update unchanged", async () => {
    const tenantId = "tenant_cas";
    await seedTenant(tenantId);
    const initial = record({ tenantId });
    await repository.reserve(initial);
    const changed: DurableReproductionRecord = {
      ...initial,
      snapshot: {
        ...initial.snapshot,
        case: { ...initial.snapshot.case, updatedAt: LATER },
        job: { ...initial.snapshot.job, updatedAt: LATER },
      },
      updatedAt: LATER,
    };

    const saved = await repository.save(changed, 1);
    expect(saved.version).toBe(2);
    await expect(repository.save(changed, 1)).rejects.toBeInstanceOf(
      OptimisticConcurrencyError,
    );
    await expect(
      repository.findByJobId(scope(tenantId), initial.jobId),
    ).resolves.toMatchObject({
      snapshot: { job: { attempt: 0, state: "QUEUED" } },
      version: 2,
    });
  });

  it("serializes concurrent duplicate reservations to one winner", async () => {
    const tenantId = "tenant_concurrent";
    await seedTenant(tenantId);
    const candidates = Array.from({ length: 12 }, (_, index) =>
      record({
        caseId: `case_concurrent_${index}`,
        idempotencyKey: "same_key",
        jobId: `job_concurrent_${index}`,
        tenantId,
      }),
    );

    const results = await Promise.all(
      candidates.map((candidate) => repository.reserve(candidate)),
    );

    expect(results.filter(({ created }) => created)).toHaveLength(1);
    expect(new Set(results.map(({ record: value }) => value.caseId)).size).toBe(1);
    await expect(tableCount("cases", tenantId)).resolves.toBe(1);
    await expect(tableCount("jobs", tenantId)).resolves.toBe(1);
    await expect(tableCount("idempotency_keys", tenantId)).resolves.toBe(1);
  });
});
