import type { PGlite } from "@electric-sql/pglite";

import {
  reserveDurableStart,
  type DurableStartInput,
} from "@/application/durable-start";
import type {
  DurableReproductionRecord,
  TenantScope,
} from "@/application/ports/production";
import { createCase } from "@/domain/case";
import { createJob } from "@/domain/job";
import type { PostgresUnitOfWork } from "@/infrastructure/postgres/repositories";

export const DURABLE_AT = "2026-07-19T20:00:00.000Z";
export const DURABLE_EXPIRY = "2099-07-20T20:00:00.000Z";

export function durableScope(
  tenantId: string,
  callerId = "caller_main",
): TenantScope {
  return { callerId, principalId: callerId, tenantId };
}

export function durableRecord(input: {
  callerId?: string;
  caseId?: string;
  idempotencyKey?: string;
  jobId?: string;
  tenantId: string;
}): DurableReproductionRecord {
  const callerId = input.callerId ?? "caller_main";
  const caseId = input.caseId ?? `case_${input.tenantId}`;
  const jobId = input.jobId ?? `job_${input.tenantId}`;
  const createdAt = new Date(DURABLE_AT);
  return {
    callerId,
    caseId,
    commandHash: "a".repeat(64),
    createdAt: DURABLE_AT,
    idempotencyKey: input.idempotencyKey ?? `start_${input.tenantId}`,
    jobId,
    snapshot: {
      case: createCase(caseId, createdAt),
      job: createJob(jobId, caseId, createdAt),
      result: null,
      sampleId: "cli-spaces",
      schemaVersion: "2.0",
    },
    tenantId: input.tenantId,
    updatedAt: DURABLE_AT,
    version: 1,
  };
}

export function durableStartInput(
  record: DurableReproductionRecord,
): DurableStartInput {
  return {
    auditEvent: {
      action: "case.created",
      actorId: record.callerId,
      eventId: `audit_${record.caseId}`,
      metadata: { sampleKind: "trusted-sample" },
      occurredAt: DURABLE_AT,
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
      expiresAt: DURABLE_EXPIRY,
      jobId: record.jobId,
      reservationId: `quota_${record.caseId}`,
      resource: "active-jobs",
      tenantId: record.tenantId,
    },
    record,
  };
}

export async function seedDurableTenant(
  database: PGlite,
  unitOfWork: PostgresUnitOfWork,
  tenantId: string,
): Promise<DurableReproductionRecord> {
  await database.query(
    `INSERT INTO tenants (id, created_at, updated_at)
     VALUES ($1, $2, $2)`,
    [tenantId, "2026-07-19T19:00:00.000Z"],
  );
  const record = durableRecord({ tenantId });
  await reserveDurableStart(unitOfWork, durableStartInput(record));
  return record;
}
