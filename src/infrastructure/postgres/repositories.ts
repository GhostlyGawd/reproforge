import { createHash } from "node:crypto";

import {
  auditEventSchema,
  jobLeaseSchema,
  queueMessageSchema,
  quotaReservationSchema,
  tenantScopeSchema,
  type AuditEvent,
  type AuditSink,
  type CancellationRequestResult,
  type DurableReproductionRecord,
  type DurableReproductionRepository,
  type DurableReservationResult,
  type JobLease,
  type LeaseFailure,
  type LeaseFailureDisposition,
  type LeaseRecoverySummary,
  type Outbox,
  type OutboxClaim,
  type OutboxFailureDisposition,
  type QuotaLedger,
  type QueueMessage,
  type QuotaReservation,
  type TenantScope,
  type TransactionPorts,
  type UnitOfWork,
} from "@/application/ports/production";
import { reproductionSnapshotSchema } from "@/application/reproduction-contracts";
import { transitionCase } from "@/domain/case";
import { transitionJob } from "@/domain/job";
import { resolvedRepositoryExecutionRequestSchema } from "@/execution/contracts";

import {
  runSerializableTransaction,
  type PostgresDatabase,
  type PostgresExecutor,
} from "./database";

type DurableRow = {
  caller_id: string;
  case_domain_state: unknown;
  case_id: string;
  case_state: string;
  case_version: string | number;
  command_hash: string;
  created_at: Date | string;
  idempotency_key: string;
  job_attempt: string | number;
  job_case_id: string;
  job_created_at: Date | string;
  job_failure_code: string | null;
  job_failure_message: string | null;
  job_failure_retryable: boolean | null;
  job_id: string;
  job_progress_phase: string;
  job_state: string;
  job_updated_at: Date | string;
  job_version: string | number;
  source_descriptor: unknown;
  tenant_id: string;
  updated_at: Date | string;
};

const DURABLE_SELECT = `
SELECT
  i.tenant_id,
  i.caller_id,
  i.idempotency_key,
  trim(i.command_hash) AS command_hash,
  c.id AS case_id,
  c.source_descriptor,
  c.domain_state AS case_domain_state,
  c.state AS case_state,
  c.version AS case_version,
  c.created_at,
  c.updated_at,
  j.id AS job_id,
  j.case_id AS job_case_id,
  j.state AS job_state,
  j.progress_phase AS job_progress_phase,
  j.attempt AS job_attempt,
  j.failure_code AS job_failure_code,
  j.failure_message AS job_failure_message,
  j.failure_retryable AS job_failure_retryable,
  j.version AS job_version,
  j.created_at AS job_created_at,
  j.updated_at AS job_updated_at
FROM idempotency_keys i
JOIN cases c
  ON c.tenant_id = i.tenant_id AND c.id = i.case_id
JOIN jobs j
  ON j.tenant_id = i.tenant_id
 AND j.case_id = i.case_id
 AND j.id = i.job_id`;

export class InvalidDurableRecordError extends Error {
  readonly code = "INVALID_DURABLE_RECORD";

  constructor() {
    super("The durable reproduction record is invalid");
    this.name = "InvalidDurableRecordError";
  }
}

export class CorruptDurableRecordError extends Error {
  readonly code = "CORRUPT_DURABLE_RECORD";

  constructor() {
    super("The stored durable reproduction record is invalid");
    this.name = "CorruptDurableRecordError";
  }
}

export class OptimisticConcurrencyError extends Error {
  readonly code = "OPTIMISTIC_CONFLICT";

  constructor() {
    super("The durable reproduction changed before it could be saved");
    this.name = "OptimisticConcurrencyError";
  }
}

export class LeaseOwnershipError extends Error {
  readonly code = "LEASE_NOT_OWNED";

  constructor() {
    super("The worker does not own the active job lease");
    this.name = "LeaseOwnershipError";
  }
}

export class QuotaReservationError extends Error {
  readonly code = "QUOTA_RESERVATION_NOT_ACTIVE";

  constructor() {
    super("The quota reservation is not active");
    this.name = "QuotaReservationError";
  }
}

function cloneRecord(record: DurableReproductionRecord): DurableReproductionRecord {
  return structuredClone(record);
}

function timestamp(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new CorruptDurableRecordError();
  return parsed.toISOString();
}

function integer(value: string | number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new CorruptDurableRecordError();
  return parsed;
}

function canonicalTimestamp(value: string): string | null {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value
    ? null
    : parsed.toISOString();
}

function recoveryEventId(
  tenantId: string,
  jobId: string,
  attempt: number,
): string {
  return `recovery_${createHash("sha256")
    .update(`${tenantId}:${jobId}:${attempt}`)
    .digest("hex")
    .slice(0, 40)}`;
}

function recoveryAuditEventId(
  tenantId: string,
  jobId: string,
  attempt: number,
): string {
  return `audit_lease_recovery_${createHash("sha256")
    .update(`${tenantId}:${jobId}:${attempt}`)
    .digest("hex")
    .slice(0, 40)}`;
}

function objectValue(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return objectValue(JSON.parse(value));
    } catch {
      throw new CorruptDurableRecordError();
    }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CorruptDurableRecordError();
  }
  return value as Record<string, unknown>;
}

function validateRecord(
  record: DurableReproductionRecord,
  options: { initial?: boolean } = {},
): DurableReproductionRecord {
  try {
    tenantScopeSchema.parse({
      callerId: record.callerId,
      principalId: record.callerId,
      tenantId: record.tenantId,
    });
    reproductionSnapshotSchema.parse(record.snapshot);
    const repositoryRequest = record.repositoryRequest
      ? resolvedRepositoryExecutionRequestSchema.parse(record.repositoryRequest)
      : undefined;
    const failure = record.snapshot.job.failure;
    if (
      !/^[a-f0-9]{64}$/.test(record.commandHash) ||
      record.idempotencyKey.length < 1 ||
      record.idempotencyKey.length > 128 ||
      record.caseId !== record.snapshot.case.id ||
      record.jobId !== record.snapshot.job.id ||
      record.caseId !== record.snapshot.job.caseId ||
      Boolean(repositoryRequest) !== Boolean(record.snapshot.repositorySource) ||
      (repositoryRequest !== undefined &&
        (repositoryRequest.source.commitSha !==
          record.snapshot.repositorySource?.commitSha ||
          repositoryRequest.source.repositoryId !==
            record.snapshot.repositorySource?.repositoryId)) ||
      (record.requestedBudget !== undefined &&
        (!Number.isInteger(record.requestedBudget.maxToolCalls) ||
          record.requestedBudget.maxToolCalls < 1 ||
          record.requestedBudget.maxToolCalls > 20 ||
          !Number.isInteger(record.requestedBudget.requiredRuns) ||
          record.requestedBudget.requiredRuns < 1 ||
          record.requestedBudget.requiredRuns > 5)) ||
      !Number.isSafeInteger(record.version) ||
      record.version < 1 ||
      (options.initial && record.version !== 1) ||
      Date.parse(record.updatedAt) < Date.parse(record.createdAt) ||
      record.createdAt !== new Date(record.createdAt).toISOString() ||
      record.updatedAt !== new Date(record.updatedAt).toISOString()
      || (failure !== null &&
        (!/^[A-Z][A-Z0-9_]{0,95}$/.test(failure.code) ||
          failure.message.length > 512 ||
          /[\u0000-\u001f\u007f]/.test(failure.message) ||
          /(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|bearer\s+\S{8,}|postgres(?:ql)?:\/\/[^@\s]+@)/i.test(
            failure.message,
          )))
    ) {
      throw new Error("invalid");
    }
  } catch {
    throw new InvalidDurableRecordError();
  }
  return record;
}

function serializeCaseDomain(record: DurableReproductionRecord): string {
  return JSON.stringify({
    case: record.snapshot.case,
    ...(record.snapshot.repositorySource
      ? { repositorySource: record.snapshot.repositorySource }
      : {}),
    result: record.snapshot.result,
    ...(record.snapshot.sampleId ? { sampleId: record.snapshot.sampleId } : {}),
    schemaVersion: record.snapshot.schemaVersion,
  });
}

function rowToRecord(row: DurableRow): DurableReproductionRecord {
  try {
    const domain = objectValue(row.case_domain_state);
    const sourceDescriptor = objectValue(row.source_descriptor);
    const requestedBudget = sourceDescriptor.budget;
    const parsedBudget =
      requestedBudget === undefined
        ? undefined
        : objectValue(requestedBudget);
    const rawRepositoryRequest = sourceDescriptor.repositoryRequest;
    const repositoryRequest =
      rawRepositoryRequest === undefined
        ? undefined
        : resolvedRepositoryExecutionRequestSchema.parse(rawRepositoryRequest);
    const version = integer(row.case_version);
    if (version !== integer(row.job_version)) throw new CorruptDurableRecordError();
    const failure =
      row.job_failure_code === null &&
      row.job_failure_message === null &&
      row.job_failure_retryable === null
        ? null
        : {
            code: row.job_failure_code,
            message: row.job_failure_message,
            retryable: row.job_failure_retryable,
          };
    const snapshot = reproductionSnapshotSchema.parse({
      ...domain,
      job: {
        attempt: integer(row.job_attempt),
        caseId: row.job_case_id,
        createdAt: timestamp(row.job_created_at),
        failure,
        id: row.job_id,
        progressPhase: row.job_progress_phase,
        state: row.job_state,
        updatedAt: timestamp(row.job_updated_at),
      },
    });
    if (snapshot.case.state !== row.case_state) {
      throw new CorruptDurableRecordError();
    }
    return validateRecord({
      callerId: row.caller_id,
      caseId: row.case_id,
      commandHash: row.command_hash,
      createdAt: timestamp(row.created_at),
      idempotencyKey: row.idempotency_key,
      jobId: row.job_id,
      ...(parsedBudget
        ? {
            requestedBudget: {
              maxToolCalls: Number(parsedBudget.maxToolCalls),
              requiredRuns: Number(parsedBudget.requiredRuns),
            },
          }
        : {}),
      ...(repositoryRequest ? { repositoryRequest } : {}),
      snapshot,
      tenantId: row.tenant_id,
      updatedAt: timestamp(row.updated_at),
      version,
    });
  } catch (error) {
    if (error instanceof CorruptDurableRecordError) throw error;
    throw new CorruptDurableRecordError();
  }
}

function isDatabase(
  source: PostgresDatabase | PostgresExecutor,
): source is PostgresDatabase {
  return "transaction" in source;
}

export class PostgresDurableReproductionRepository
  implements DurableReproductionRepository
{
  constructor(private readonly source: PostgresDatabase | PostgresExecutor) {}

  async findByCaseId(
    rawScope: TenantScope,
    caseId: string,
  ): Promise<DurableReproductionRecord | null> {
    const scope = tenantScopeSchema.parse(rawScope);
    return this.find(
      `${DURABLE_SELECT}
       WHERE i.tenant_id = $1 AND i.caller_id = $2 AND c.id = $3
       LIMIT 1`,
      [scope.tenantId, scope.callerId, caseId],
    );
  }

  async findByIdempotencyKey(
    rawScope: TenantScope,
    idempotencyKey: string,
  ): Promise<DurableReproductionRecord | null> {
    const scope = tenantScopeSchema.parse(rawScope);
    return this.find(
      `${DURABLE_SELECT}
       WHERE i.tenant_id = $1 AND i.caller_id = $2 AND i.idempotency_key = $3
       LIMIT 1`,
      [scope.tenantId, scope.callerId, idempotencyKey],
    );
  }

  async findByJobId(
    rawScope: TenantScope,
    jobId: string,
  ): Promise<DurableReproductionRecord | null> {
    const scope = tenantScopeSchema.parse(rawScope);
    return this.find(
      `${DURABLE_SELECT}
       WHERE i.tenant_id = $1 AND i.caller_id = $2 AND j.id = $3
       LIMIT 1`,
      [scope.tenantId, scope.callerId, jobId],
    );
  }

  async findByLease(rawLease: JobLease): Promise<DurableReproductionRecord | null> {
    const lease = jobLeaseSchema.parse(rawLease);
    return this.find(
      `${DURABLE_SELECT}
       WHERE j.tenant_id = $1 AND j.id = $2
         AND j.lease_owner = $3 AND j.attempt = $4
         AND j.lease_acquired_at = $5 AND j.lease_expires_at = $6
         AND j.state = 'RUNNING'
       LIMIT 1`,
      [
        lease.tenantId,
        lease.jobId,
        lease.ownerId,
        lease.attempt,
        lease.acquiredAt,
        lease.expiresAt,
      ],
    );
  }

  async reserve(
    rawRecord: DurableReproductionRecord,
  ): Promise<DurableReservationResult> {
    const record = validateRecord(rawRecord, { initial: true });
    return this.write((repository) => repository.reserveInTransaction(record));
  }

  async save(
    rawRecord: DurableReproductionRecord,
    expectedVersion: number,
  ): Promise<DurableReproductionRecord> {
    const record = validateRecord(rawRecord);
    if (record.version !== expectedVersion || expectedVersion < 1) {
      throw new OptimisticConcurrencyError();
    }
    return this.write((repository) =>
      repository.saveInTransaction(record, expectedVersion),
    );
  }

  async claimLease(input: {
    at: string;
    jobId: string;
    leaseSeconds: number;
    ownerId: string;
    tenantId: string;
  }): Promise<JobLease | null> {
    const acquiredAt = new Date(input.at);
    if (
      Number.isNaN(acquiredAt.getTime()) ||
      acquiredAt.toISOString() !== input.at ||
      !Number.isInteger(input.leaseSeconds) ||
      input.leaseSeconds < 1 ||
      input.leaseSeconds > 3_600
    ) {
      throw new LeaseOwnershipError();
    }
    const expiresAt = new Date(
      acquiredAt.getTime() + input.leaseSeconds * 1_000,
    ).toISOString();
    return this.write(async (repository) => {
      const tenant = await repository.source.query<{ status: string }>(
        "SELECT status FROM tenants WHERE id = $1 FOR UPDATE",
        [input.tenantId],
      );
      if (tenant.rows[0]?.status !== "ACTIVE") return null;
      const result = await repository.source.query<{
        attempt: number | string;
        case_id: string;
        version: number | string;
      }>(
        `UPDATE jobs
            SET state = 'RUNNING',
                attempt = attempt + 1,
                lease_owner = $3,
                lease_acquired_at = $4,
                lease_expires_at = $5,
                updated_at = $4,
                version = version + 1
          WHERE tenant_id = $1
            AND id = $2
            AND attempt < max_attempts
            AND (
              (state = 'QUEUED' AND next_attempt_at <= $4)
              OR (state = 'RUNNING' AND lease_expires_at <= $4)
            )
          RETURNING attempt, case_id, version`,
        [input.tenantId, input.jobId, input.ownerId, input.at, expiresAt],
      );
      const row = result.rows[0];
      if (!row) return null;
      await repository.advanceCaseVersion(
        input.tenantId,
        row.case_id,
        integer(row.version) - 1,
        input.at,
      );
      return jobLeaseSchema.parse({
        acquiredAt: acquiredAt.toISOString(),
        attempt: integer(row.attempt),
        expiresAt,
        jobId: input.jobId,
        ownerId: input.ownerId,
        tenantId: input.tenantId,
      });
    });
  }

  async renewLease(
    rawLease: JobLease,
    input: { at: string; expiresAt: string },
  ): Promise<JobLease> {
    const lease = jobLeaseSchema.parse(rawLease);
    const at = canonicalTimestamp(input.at);
    const canonicalExpiresAt = canonicalTimestamp(input.expiresAt);
    if (
      !at ||
      !canonicalExpiresAt ||
      Date.parse(at) < Date.parse(lease.acquiredAt) ||
      Date.parse(at) >= Date.parse(lease.expiresAt) ||
      Date.parse(canonicalExpiresAt) <= Date.parse(lease.expiresAt)
    ) {
      throw new LeaseOwnershipError();
    }
    return this.write(async (repository) => {
      const result = await repository.source.query<{
        case_id: string;
        id: string;
        version: number | string;
      }>(
        `UPDATE jobs
            SET lease_expires_at = $5,
                updated_at = $6,
                version = version + 1
          WHERE tenant_id = $1 AND id = $2
            AND lease_owner = $3 AND attempt = $4
            AND state = 'RUNNING' AND lease_expires_at = $7
          RETURNING id, case_id, version`,
        [
          lease.tenantId,
          lease.jobId,
          lease.ownerId,
          lease.attempt,
          canonicalExpiresAt,
          at,
          lease.expiresAt,
        ],
      );
      const row = result.rows[0];
      if (!row) throw new LeaseOwnershipError();
      await repository.advanceCaseVersion(
        lease.tenantId,
        row.case_id,
        integer(row.version) - 1,
        at,
      );
      return jobLeaseSchema.parse({ ...lease, expiresAt: canonicalExpiresAt });
    });
  }

  async releaseLease(
    rawLease: JobLease,
    input: { at: string; nextAttemptAt: string },
  ): Promise<void> {
    const lease = jobLeaseSchema.parse(rawLease);
    await this.failLease(lease, {
      at: input.at,
      code: "LEASE_RELEASED",
      nextAttemptAt: input.nextAttemptAt,
      retryable: true,
    });
  }

  async completeLease(
    rawLease: JobLease,
    rawRecord: DurableReproductionRecord,
  ): Promise<DurableReproductionRecord> {
    const lease = jobLeaseSchema.parse(rawLease);
    const record = validateRecord(rawRecord);
    if (
      record.tenantId !== lease.tenantId ||
      record.jobId !== lease.jobId ||
      record.snapshot.job.attempt !== lease.attempt ||
      (record.snapshot.job.state !== "SUCCEEDED" &&
        record.snapshot.job.state !== "FAILED")
    ) {
      throw new LeaseOwnershipError();
    }
    return this.write(async (repository) => {
      if (
        record.snapshot.job.state === "SUCCEEDED" &&
        (record.snapshot.case.state === "VERIFIED" ||
          record.snapshot.job.progressPhase === "VERIFIED")
      ) {
        const artifact = await repository.source.query<{ found: boolean }>(
          `SELECT true AS found
             FROM artifacts
            WHERE tenant_id = $1 AND case_id = $2
              AND kind = 'bundle' AND status = 'AVAILABLE'
            LIMIT 1`,
          [record.tenantId, record.caseId],
        );
        if (!artifact.rows[0]?.found) throw new InvalidDurableRecordError();
      }
      const nextVersion = record.version + 1;
      const savedCase = await repository.source.query<{ version: number | string }>(
        `UPDATE cases
            SET state = $4,
                domain_state = $5::jsonb,
                schema_version = $6,
                updated_at = $7,
                version = version + 1
          WHERE tenant_id = $1 AND id = $2 AND version = $3
          RETURNING version`,
        [
          record.tenantId,
          record.caseId,
          record.version,
          record.snapshot.case.state,
          serializeCaseDomain(record),
          record.snapshot.schemaVersion,
          record.updatedAt,
        ],
      );
      if (integer(savedCase.rows[0]?.version ?? 0) !== nextVersion) {
        throw new OptimisticConcurrencyError();
      }
      const failure = record.snapshot.job.failure;
      const savedJob = await repository.source.query<{ version: number | string }>(
        `UPDATE jobs
            SET state = $10,
                progress_phase = $11,
                failure_code = $12,
                failure_message = $13,
                failure_retryable = $14,
                lease_owner = NULL,
                lease_acquired_at = NULL,
                lease_expires_at = NULL,
                updated_at = $15,
                version = version + 1
          WHERE tenant_id = $1 AND id = $2 AND version = $3
            AND state = 'RUNNING' AND lease_owner = $4 AND attempt = $5
            AND lease_acquired_at = $6 AND lease_expires_at = $7
            AND case_id = $8 AND attempt = $9
            AND cancellation_requested_at IS NULL
          RETURNING version`,
        [
          lease.tenantId,
          lease.jobId,
          record.version,
          lease.ownerId,
          lease.attempt,
          lease.acquiredAt,
          lease.expiresAt,
          record.caseId,
          record.snapshot.job.attempt,
          record.snapshot.job.state,
          record.snapshot.job.progressPhase,
          failure?.code ?? null,
          failure?.message ?? null,
          failure?.retryable ?? null,
          record.updatedAt,
        ],
      );
      if (integer(savedJob.rows[0]?.version ?? 0) !== nextVersion) {
        throw new LeaseOwnershipError();
      }
      await repository.releaseActiveJobQuota(
        lease.tenantId,
        lease.jobId,
        record.updatedAt,
      );
      return cloneRecord({ ...record, version: nextVersion });
    });
  }

  async failLease(
    rawLease: JobLease,
    failure: LeaseFailure,
  ): Promise<LeaseFailureDisposition> {
    const lease = jobLeaseSchema.parse(rawLease);
    const at = canonicalTimestamp(failure.at);
    const nextAttemptAt = canonicalTimestamp(failure.nextAttemptAt);
    if (
      !at ||
      !nextAttemptAt ||
      Date.parse(at) < Date.parse(lease.acquiredAt) ||
      Date.parse(nextAttemptAt) < Date.parse(at) ||
      !/^[A-Z][A-Z0-9_]{0,95}$/.test(failure.code)
    ) {
      throw new LeaseOwnershipError();
    }
    return this.write(async (repository) => {
      const current = await repository.source.query<{
        attempt: number | string;
        cancellation_requested_at: Date | string | null;
        case_id: string;
        max_attempts: number | string;
        version: number | string;
      }>(
        `SELECT attempt, cancellation_requested_at, case_id, max_attempts, version
           FROM jobs
          WHERE tenant_id = $1 AND id = $2 AND state = 'RUNNING'
            AND lease_owner = $3 AND attempt = $4
            AND lease_acquired_at = $5 AND lease_expires_at = $6
          FOR UPDATE`,
        [
          lease.tenantId,
          lease.jobId,
          lease.ownerId,
          lease.attempt,
          lease.acquiredAt,
          lease.expiresAt,
        ],
      );
      const row = current.rows[0];
      if (!row) throw new LeaseOwnershipError();
      if (row.cancellation_requested_at !== null) {
        await repository.cancelLeaseInTransaction(lease, at);
        return "cancelled";
      }
      const attempt = integer(row.attempt);
      const requeue = failure.retryable && attempt < integer(row.max_attempts);
      const failureCode = requeue
        ? null
        : failure.retryable
          ? "JOB_RETRY_EXHAUSTED"
          : failure.code;
      const failureMessage = requeue
        ? null
        : failure.retryable
          ? "The durable worker exhausted its retry budget"
          : "The durable worker failed safely";
      const updated = await repository.source.query<{ version: number | string }>(
        `UPDATE jobs
            SET state = $7,
                next_attempt_at = $8,
                lease_owner = NULL,
                lease_acquired_at = NULL,
                lease_expires_at = NULL,
                failure_code = $9,
                failure_message = $10,
                failure_retryable = $11,
                updated_at = $12,
                version = version + 1
          WHERE tenant_id = $1 AND id = $2 AND state = 'RUNNING'
            AND lease_owner = $3 AND attempt = $4
            AND lease_acquired_at = $5 AND lease_expires_at = $6
          RETURNING version`,
        [
          lease.tenantId,
          lease.jobId,
          lease.ownerId,
          lease.attempt,
          lease.acquiredAt,
          lease.expiresAt,
          requeue ? "QUEUED" : "FAILED",
          nextAttemptAt,
          failureCode,
          failureMessage,
          requeue ? null : false,
          at,
        ],
      );
      const version = integer(updated.rows[0]?.version ?? 0);
      if (version !== integer(row.version) + 1) {
        throw new LeaseOwnershipError();
      }
      await repository.advanceCaseVersion(
        lease.tenantId,
        row.case_id,
        integer(row.version),
        at,
      );
      if (requeue) {
        const eventId = recoveryEventId(
          lease.tenantId,
          lease.jobId,
          lease.attempt,
        );
        const message = queueMessageSchema.parse({
          caseId: row.case_id,
          eventId,
          jobId: lease.jobId,
          kind: "reproduction.recovery-requested",
          schemaVersion: "1.0",
          tenantId: lease.tenantId,
        });
        await repository.source.query(
          `INSERT INTO outbox_events (
             tenant_id, id, case_id, job_id, kind, schema_version, payload,
             next_attempt_at, created_at, updated_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $9)
           ON CONFLICT (tenant_id, id) DO NOTHING`,
          [
            message.tenantId,
            message.eventId,
            message.caseId,
            message.jobId,
            message.kind,
            message.schemaVersion,
            JSON.stringify(message),
            nextAttemptAt,
            at,
          ],
        );
      } else {
        await repository.releaseActiveJobQuota(
          lease.tenantId,
          lease.jobId,
          at,
        );
      }
      return requeue ? "requeued" : "exhausted";
    });
  }

  async recoverExpiredLeases(input: {
    at: string;
    limit: number;
  }): Promise<LeaseRecoverySummary> {
    const at = canonicalTimestamp(input.at);
    if (!at || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > 1_000) {
      throw new LeaseOwnershipError();
    }
    return this.write(async (repository) => {
      const expired = await repository.source.query<{
        attempt: number | string;
        id: string;
        lease_acquired_at: Date | string;
        lease_expires_at: Date | string;
        lease_owner: string;
        tenant_id: string;
      }>(
        `SELECT tenant_id, id, attempt, lease_owner,
                lease_acquired_at, lease_expires_at
           FROM jobs
          WHERE state = 'RUNNING' AND lease_expires_at <= $1
          ORDER BY lease_expires_at, tenant_id, id
          FOR UPDATE SKIP LOCKED
          LIMIT $2`,
        [at, input.limit],
      );
      const summary = {
        cancelled: 0,
        exhausted: 0,
        requeued: 0,
      };
      for (const row of expired.rows) {
        const lease = jobLeaseSchema.parse({
          acquiredAt: timestamp(row.lease_acquired_at),
          attempt: integer(row.attempt),
          expiresAt: timestamp(row.lease_expires_at),
          jobId: row.id,
          ownerId: row.lease_owner,
          tenantId: row.tenant_id,
        });
        const disposition = await repository.failLease(lease, {
          at,
          code: "LEASE_EXPIRED",
          nextAttemptAt: at,
          retryable: true,
        });
        summary[disposition] += 1;
        await new PostgresAuditSink(repository.source).append({
          action: "job.lease-recovered",
          actorId: "operator:lease-recovery",
          eventId: recoveryAuditEventId(
            lease.tenantId,
            lease.jobId,
            lease.attempt,
          ),
          metadata: {
            attempt: lease.attempt,
            disposition,
          },
          occurredAt: at,
          outcome: disposition === "exhausted" ? "failure" : "success",
          targetId: lease.jobId,
          targetType: "job",
          tenantId: lease.tenantId,
        });
      }
      return summary;
    });
  }

  async requestCancellation(
    rawScope: TenantScope,
    jobId: string,
    requestedAt: string,
  ): Promise<CancellationRequestResult | null> {
    const scope = tenantScopeSchema.parse(rawScope);
    const at = canonicalTimestamp(requestedAt);
    if (!at || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(jobId)) {
      throw new InvalidDurableRecordError();
    }
    return this.write(async (repository) => {
      const selected = await repository.source.query<{
        cancellation_requested_at: Date | string | null;
        case_id: string;
        state: string;
        version: number | string;
      }>(
        `SELECT j.case_id, j.state, j.version, j.cancellation_requested_at
           FROM jobs j
           JOIN idempotency_keys i
             ON i.tenant_id = j.tenant_id AND i.job_id = j.id
          WHERE j.tenant_id = $1 AND j.id = $2 AND i.caller_id = $3
          FOR UPDATE OF j`,
        [scope.tenantId, jobId, scope.callerId],
      );
      const selectedJob = selected.rows[0];
      if (!selectedJob) return null;
      if (selectedJob.state === "CANCELLED") {
        return {
          caseId: selectedJob.case_id,
          changed: false,
          disposition: "cancelled",
        };
      }
      if (
        selectedJob.state === "RUNNING" &&
        selectedJob.cancellation_requested_at !== null
      ) {
        return {
          caseId: selectedJob.case_id,
          changed: false,
          disposition: "requested",
        };
      }
      if (selectedJob.state !== "QUEUED" && selectedJob.state !== "RUNNING") {
        return null;
      }

      const record = await repository.findByJobId(scope, jobId);
      if (!record || record.version !== integer(selectedJob.version)) {
        throw new CorruptDurableRecordError();
      }
      if (Date.parse(at) < Date.parse(record.createdAt)) {
        throw new InvalidDurableRecordError();
      }
      if (selectedJob.state === "RUNNING") {
        const updated = await repository.source.query<{ version: number | string }>(
          `UPDATE jobs
              SET cancellation_requested_at = $4,
                  updated_at = $4,
                  version = version + 1
            WHERE tenant_id = $1 AND id = $2 AND version = $3
              AND state = 'RUNNING' AND cancellation_requested_at IS NULL
            RETURNING version`,
          [scope.tenantId, jobId, record.version, at],
        );
        if (integer(updated.rows[0]?.version ?? 0) !== record.version + 1) {
          throw new OptimisticConcurrencyError();
        }
        await repository.advanceCaseVersion(
          scope.tenantId,
          record.caseId,
          record.version,
          at,
        );
        return {
          caseId: record.caseId,
          changed: true,
          disposition: "requested",
        };
      }

      const cancelledCase = transitionCase(
        record.snapshot.case,
        "CANCELLED",
        "Cancellation requested",
        new Date(at),
      );
      const cancelledJob = transitionJob(record.snapshot.job, "CANCELLED", {
        at: new Date(at),
        progressPhase: "CANCELLED",
      });
      const cancelledRecord: DurableReproductionRecord = {
        ...record,
        snapshot: {
          ...record.snapshot,
          case: cancelledCase,
          job: cancelledJob,
        },
        updatedAt: at,
      };
      const savedCase = await repository.source.query<{ version: number | string }>(
        `UPDATE cases
            SET state = 'CANCELLED', domain_state = $4::jsonb,
                updated_at = $5, version = version + 1
          WHERE tenant_id = $1 AND id = $2 AND version = $3
          RETURNING version`,
        [
          scope.tenantId,
          record.caseId,
          record.version,
          serializeCaseDomain(cancelledRecord),
          at,
        ],
      );
      if (integer(savedCase.rows[0]?.version ?? 0) !== record.version + 1) {
        throw new OptimisticConcurrencyError();
      }
      const savedJob = await repository.source.query<{ version: number | string }>(
        `UPDATE jobs
            SET state = 'CANCELLED', progress_phase = 'CANCELLED',
                cancellation_requested_at = $4, cancelled_at = $4,
                updated_at = $4, version = version + 1
          WHERE tenant_id = $1 AND id = $2 AND version = $3
            AND state = 'QUEUED'
          RETURNING version`,
        [scope.tenantId, jobId, record.version, at],
      );
      if (integer(savedJob.rows[0]?.version ?? 0) !== record.version + 1) {
        throw new OptimisticConcurrencyError();
      }
      await repository.releaseActiveJobQuota(scope.tenantId, jobId, at);
      return {
        caseId: record.caseId,
        changed: true,
        disposition: "cancelled",
      };
    });
  }

  async isCancellationRequested(rawLease: JobLease): Promise<boolean> {
    const lease = jobLeaseSchema.parse(rawLease);
    const result = await this.source.query<{ requested: boolean }>(
      `SELECT cancellation_requested_at IS NOT NULL AS requested
         FROM jobs
        WHERE tenant_id = $1 AND id = $2 AND state = 'RUNNING'
          AND lease_owner = $3 AND attempt = $4
          AND lease_acquired_at = $5 AND lease_expires_at = $6`,
      [
        lease.tenantId,
        lease.jobId,
        lease.ownerId,
        lease.attempt,
        lease.acquiredAt,
        lease.expiresAt,
      ],
    );
    return result.rows[0]?.requested === true;
  }

  async cancelLease(
    rawLease: JobLease,
    input: { at: string },
  ): Promise<DurableReproductionRecord> {
    const lease = jobLeaseSchema.parse(rawLease);
    const at = canonicalTimestamp(input.at);
    if (!at || Date.parse(at) < Date.parse(lease.acquiredAt)) {
      throw new LeaseOwnershipError();
    }
    return this.write((repository) =>
      repository.cancelLeaseInTransaction(lease, at),
    );
  }

  private async cancelLeaseInTransaction(
    lease: JobLease,
    at: string,
  ): Promise<DurableReproductionRecord> {
    const owned = await this.source.query<{ version: number | string }>(
      `SELECT version
         FROM jobs
        WHERE tenant_id = $1 AND id = $2 AND state = 'RUNNING'
          AND lease_owner = $3 AND attempt = $4
          AND lease_acquired_at = $5 AND lease_expires_at = $6
          AND cancellation_requested_at IS NOT NULL
        FOR UPDATE`,
      [
        lease.tenantId,
        lease.jobId,
        lease.ownerId,
        lease.attempt,
        lease.acquiredAt,
        lease.expiresAt,
      ],
    );
    const version = integer(owned.rows[0]?.version ?? 0);
    if (version < 1) throw new LeaseOwnershipError();
    const record = await this.findByLease(lease);
    if (!record || record.version !== version) throw new LeaseOwnershipError();
    const cancelledCase = transitionCase(
      record.snapshot.case,
      "CANCELLED",
      "Cancellation requested",
      new Date(at),
    );
    const cancelledJob = transitionJob(record.snapshot.job, "CANCELLED", {
      at: new Date(at),
      progressPhase: "CANCELLED",
    });
    const cancelledRecord: DurableReproductionRecord = {
      ...record,
      snapshot: {
        ...record.snapshot,
        case: cancelledCase,
        job: cancelledJob,
      },
      updatedAt: at,
    };
    const savedCase = await this.source.query<{ version: number | string }>(
      `UPDATE cases
          SET state = 'CANCELLED', domain_state = $4::jsonb,
              updated_at = $5, version = version + 1
        WHERE tenant_id = $1 AND id = $2 AND version = $3
        RETURNING version`,
      [
        lease.tenantId,
        record.caseId,
        version,
        serializeCaseDomain(cancelledRecord),
        at,
      ],
    );
    if (integer(savedCase.rows[0]?.version ?? 0) !== version + 1) {
      throw new OptimisticConcurrencyError();
    }
    const savedJob = await this.source.query<{ version: number | string }>(
      `UPDATE jobs
          SET state = 'CANCELLED', progress_phase = 'CANCELLED',
              cancelled_at = $7,
              lease_owner = NULL, lease_acquired_at = NULL, lease_expires_at = NULL,
              updated_at = $7, version = version + 1
        WHERE tenant_id = $1 AND id = $2 AND state = 'RUNNING'
          AND lease_owner = $3 AND attempt = $4
          AND lease_acquired_at = $5 AND lease_expires_at = $6
          AND cancellation_requested_at IS NOT NULL AND version = $8
        RETURNING version`,
      [
        lease.tenantId,
        lease.jobId,
        lease.ownerId,
        lease.attempt,
        lease.acquiredAt,
        lease.expiresAt,
        at,
        version,
      ],
    );
    if (integer(savedJob.rows[0]?.version ?? 0) !== version + 1) {
      throw new LeaseOwnershipError();
    }
    await this.releaseActiveJobQuota(lease.tenantId, lease.jobId, at);
    return cloneRecord({ ...cancelledRecord, version: version + 1 });
  }

  private async releaseActiveJobQuota(
    tenantId: string,
    jobId: string,
    at: string,
  ): Promise<number> {
    const released = await this.source.query<{ id: string }>(
      `UPDATE quota_ledger
          SET state = 'RELEASED', updated_at = $3
        WHERE tenant_id = $1 AND job_id = $2
          AND resource = 'active-jobs' AND state = 'RESERVED'
        RETURNING id`,
      [tenantId, jobId, at],
    );
    return released.rows.length;
  }

  private async find(
    sql: string,
    parameters: readonly unknown[],
  ): Promise<DurableReproductionRecord | null> {
    const result = await this.source.query<DurableRow>(sql, parameters);
    const row = result.rows[0];
    return row ? rowToRecord(row) : null;
  }

  private async advanceCaseVersion(
    tenantId: string,
    caseId: string,
    expectedVersion: number,
    updatedAt: string,
  ): Promise<void> {
    const result = await this.source.query<{ version: number | string }>(
      `UPDATE cases
          SET version = version + 1, updated_at = $4
        WHERE tenant_id = $1 AND id = $2 AND version = $3
        RETURNING version`,
      [tenantId, caseId, expectedVersion, updatedAt],
    );
    if (integer(result.rows[0]?.version ?? 0) !== expectedVersion + 1) {
      throw new OptimisticConcurrencyError();
    }
  }

  private async write<T>(
    operation: (repository: PostgresDurableReproductionRepository) => Promise<T>,
  ): Promise<T> {
    if (!isDatabase(this.source)) return operation(this);
    return runSerializableTransaction(this.source, (executor) =>
      operation(new PostgresDurableReproductionRepository(executor)),
    );
  }

  private async reserveInTransaction(
    record: DurableReproductionRecord,
  ): Promise<DurableReservationResult> {
    const tenant = await this.source.query<{ status: string }>(
      "SELECT status FROM tenants WHERE id = $1 FOR UPDATE",
      [record.tenantId],
    );
    if (tenant.rows[0]?.status !== "ACTIVE") {
      throw new InvalidDurableRecordError();
    }
    await this.source.query(
      "SELECT pg_advisory_xact_lock(hashtext($1)) AS idempotency_lock",
      [JSON.stringify([record.tenantId, record.callerId, record.idempotencyKey])],
    );
    const existing = await this.findByIdempotencyKey(
      {
        callerId: record.callerId,
        principalId: record.callerId,
        tenantId: record.tenantId,
      },
      record.idempotencyKey,
    );
    if (existing) return { created: false, record: existing };

    await this.source.query(
      `INSERT INTO cases (
         tenant_id, id, source_kind, source_descriptor, state, domain_state,
         schema_version, version, created_at, updated_at
       ) VALUES ($1, $2, $3, $4::jsonb, $5, $6::jsonb, $7, 1, $8, $9)`,
      [
        record.tenantId,
        record.caseId,
        record.repositoryRequest ? "github" : "trusted-sample",
        JSON.stringify({
          ...(record.requestedBudget
            ? { budget: record.requestedBudget }
            : {}),
          ...(record.repositoryRequest
            ? { repositoryRequest: record.repositoryRequest }
            : { sampleId: record.snapshot.sampleId }),
        }),
        record.snapshot.case.state,
        serializeCaseDomain(record),
        record.snapshot.schemaVersion,
        record.createdAt,
        record.updatedAt,
      ],
    );
    const failure = record.snapshot.job.failure;
    await this.source.query(
      `INSERT INTO jobs (
         tenant_id, id, case_id, state, progress_phase, attempt, max_attempts,
         next_attempt_at, failure_code, failure_message, failure_retryable,
         version, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, 3, $7, $8, $9, $10, 1, $11, $12
       )`,
      [
        record.tenantId,
        record.jobId,
        record.caseId,
        record.snapshot.job.state,
        record.snapshot.job.progressPhase,
        record.snapshot.job.attempt,
        record.createdAt,
        failure?.code ?? null,
        failure?.message ?? null,
        failure?.retryable ?? null,
        record.snapshot.job.createdAt,
        record.snapshot.job.updatedAt,
      ],
    );
    await this.source.query(
      `INSERT INTO idempotency_keys (
         tenant_id, caller_id, idempotency_key, command_hash, case_id, job_id,
         created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        record.tenantId,
        record.callerId,
        record.idempotencyKey,
        record.commandHash,
        record.caseId,
        record.jobId,
        record.createdAt,
      ],
    );
    return { created: true, record: cloneRecord(record) };
  }

  private async saveInTransaction(
    record: DurableReproductionRecord,
    expectedVersion: number,
  ): Promise<DurableReproductionRecord> {
    if (record.snapshot.job.state !== "QUEUED") {
      throw new OptimisticConcurrencyError();
    }
    const nextVersion = expectedVersion + 1;
    const savedCase = await this.source.query<{ version: number | string }>(
      `UPDATE cases
          SET state = $4,
              domain_state = $5::jsonb,
              schema_version = $6,
              updated_at = $7,
              version = version + 1
        WHERE tenant_id = $1 AND id = $2 AND version = $3
        RETURNING version`,
      [
        record.tenantId,
        record.caseId,
        expectedVersion,
        record.snapshot.case.state,
        serializeCaseDomain(record),
        record.snapshot.schemaVersion,
        record.updatedAt,
      ],
    );
    if (integer(savedCase.rows[0]?.version ?? 0) !== nextVersion) {
      throw new OptimisticConcurrencyError();
    }

    const failure = record.snapshot.job.failure;
    const savedJob = await this.source.query<{ version: number | string }>(
      `UPDATE jobs
          SET state = $4,
              progress_phase = $5,
              attempt = $6,
              failure_code = $7,
              failure_message = $8,
              failure_retryable = $9,
              updated_at = $10,
              version = version + 1
        WHERE tenant_id = $1 AND id = $2 AND version = $3
          AND state = $4 AND progress_phase = $5 AND attempt = $6
          AND lease_owner IS NULL
        RETURNING version`,
      [
        record.tenantId,
        record.jobId,
        expectedVersion,
        record.snapshot.job.state,
        record.snapshot.job.progressPhase,
        record.snapshot.job.attempt,
        failure?.code ?? null,
        failure?.message ?? null,
        failure?.retryable ?? null,
        record.updatedAt,
      ],
    );
    if (integer(savedJob.rows[0]?.version ?? 0) !== nextVersion) {
      throw new OptimisticConcurrencyError();
    }
    return cloneRecord({ ...record, version: nextVersion });
  }
}

export class PostgresOutbox implements Outbox {
  constructor(private readonly source: PostgresDatabase | PostgresExecutor) {}

  async append(rawMessage: QueueMessage): Promise<void> {
    const message = queueMessageSchema.parse(rawMessage);
    await this.source.query(
      `INSERT INTO outbox_events (
         tenant_id, id, case_id, job_id, kind, schema_version, payload,
         updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, CURRENT_TIMESTAMP)`,
      [
        message.tenantId,
        message.eventId,
        message.caseId,
        message.jobId,
        message.kind,
        message.schemaVersion,
        JSON.stringify(message),
      ],
    );
  }

  async claimPending(input: {
    at: string;
    claimSeconds: number;
    limit: number;
    ownerId: string;
  }): Promise<OutboxClaim[]> {
    const at = canonicalTimestamp(input.at);
    if (
      !at ||
      !Number.isInteger(input.claimSeconds) ||
      input.claimSeconds < 1 ||
      input.claimSeconds > 3_600 ||
      !Number.isInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 1_000 ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.ownerId)
    ) {
      return [];
    }
    const claimExpiresAt = new Date(
      Date.parse(at) + input.claimSeconds * 1_000,
    ).toISOString();
    return this.write(async (outbox) => {
      const result = await outbox.source.query<{
        delivery_count: number | string;
        payload: unknown;
        version: number | string;
      }>(
        `WITH candidates AS (
           SELECT tenant_id, id
             FROM outbox_events
            WHERE (status = 'PENDING' AND next_attempt_at <= $1)
               OR (status = 'SENDING' AND claim_expires_at <= $1)
            ORDER BY next_attempt_at, created_at, tenant_id, id
            FOR UPDATE SKIP LOCKED
            LIMIT $2
         )
         UPDATE outbox_events AS event
            SET status = 'SENDING',
                claim_owner = $3,
                claim_expires_at = $4,
                delivery_count = delivery_count + 1,
                last_error_code = NULL,
                updated_at = $1,
                version = version + 1
           FROM candidates
          WHERE event.tenant_id = candidates.tenant_id
            AND event.id = candidates.id
         RETURNING event.payload, event.delivery_count, event.version`,
        [at, input.limit, input.ownerId, claimExpiresAt],
      );
      return result.rows.map((row) => ({
        claimedAt: at,
        claimExpiresAt,
        claimOwnerId: input.ownerId,
        deliveryAttempt: integer(row.delivery_count),
        message: queueMessageSchema.parse(row.payload),
        version: integer(row.version),
      }));
    });
  }

  async markDelivered(
    claim: OutboxClaim,
    input: { deliveredAt: string; providerMessageId: string | null },
  ): Promise<boolean> {
    const deliveredAt = canonicalTimestamp(input.deliveredAt);
    if (
      !deliveredAt ||
      Date.parse(deliveredAt) < Date.parse(claim.claimedAt) ||
      (input.providerMessageId !== null &&
        (input.providerMessageId.length < 1 ||
          input.providerMessageId.length > 512))
    ) {
      return false;
    }
    const result = await this.source.query<{ id: string }>(
      `UPDATE outbox_events
          SET status = 'DELIVERED', delivered_at = $7,
              provider_message_id = $8,
              claim_owner = NULL, claim_expires_at = NULL,
              last_error_code = NULL, updated_at = $7,
              version = version + 1
        WHERE tenant_id = $1 AND id = $2 AND status = 'SENDING'
          AND claim_owner = $3 AND claim_expires_at = $4
          AND delivery_count = $5 AND version = $6
        RETURNING id`,
      [
        claim.message.tenantId,
        claim.message.eventId,
        claim.claimOwnerId,
        claim.claimExpiresAt,
        claim.deliveryAttempt,
        claim.version,
        deliveredAt,
        input.providerMessageId,
      ],
    );
    return result.rows.length === 1;
  }

  async recordFailure(
    claim: OutboxClaim,
    input: {
      errorCode: string;
      failedAt: string;
      maxAttempts: number;
      nextAttemptAt: string;
    },
  ): Promise<OutboxFailureDisposition> {
    const failedAt = canonicalTimestamp(input.failedAt);
    const nextAttemptAt = canonicalTimestamp(input.nextAttemptAt);
    if (
      !failedAt ||
      !nextAttemptAt ||
      Date.parse(failedAt) < Date.parse(claim.claimedAt) ||
      Date.parse(nextAttemptAt) < Date.parse(failedAt) ||
      !Number.isInteger(input.maxAttempts) ||
      input.maxAttempts < 1 ||
      input.maxAttempts > 32 ||
      !/^[A-Z][A-Z0-9_]{0,95}$/.test(input.errorCode)
    ) {
      return "lost";
    }
    const result = await this.source.query<{ status: "DEAD" | "PENDING" }>(
      `UPDATE outbox_events
          SET status = CASE WHEN delivery_count >= $7 THEN 'DEAD' ELSE 'PENDING' END,
              next_attempt_at = $8,
              last_error_code = $9,
              claim_owner = NULL, claim_expires_at = NULL,
              updated_at = $10,
              version = version + 1
        WHERE tenant_id = $1 AND id = $2 AND status = 'SENDING'
          AND claim_owner = $3 AND claim_expires_at = $4
          AND delivery_count = $5 AND version = $6
        RETURNING status`,
      [
        claim.message.tenantId,
        claim.message.eventId,
        claim.claimOwnerId,
        claim.claimExpiresAt,
        claim.deliveryAttempt,
        claim.version,
        input.maxAttempts,
        nextAttemptAt,
        input.errorCode,
        failedAt,
      ],
    );
    const status = result.rows[0]?.status;
    return status === "DEAD" ? "dead" : status === "PENDING" ? "retry" : "lost";
  }

  private async write<T>(
    operation: (outbox: PostgresOutbox) => Promise<T>,
  ): Promise<T> {
    if (!isDatabase(this.source)) return operation(this);
    return runSerializableTransaction(this.source, (executor) =>
      operation(new PostgresOutbox(executor)),
    );
  }
}

type QuotaResource = QuotaReservation["resource"];
export type QuotaLimits = Readonly<Record<QuotaResource, number>>;

const DEFAULT_QUOTA_LIMITS: QuotaLimits = Object.freeze({
  "active-jobs": 2,
  "artifact-bytes": 1_073_741_824,
  "cpu-milliseconds": 3_600_000,
  exports: 20,
});

export class PostgresQuotaLedger implements QuotaLedger {
  private readonly limits: QuotaLimits;

  constructor(
    private readonly source: PostgresDatabase | PostgresExecutor,
    limits: Partial<QuotaLimits> = {},
  ) {
    this.limits = { ...DEFAULT_QUOTA_LIMITS, ...limits };
    if (
      Object.values(this.limits).some(
        (limit) => !Number.isSafeInteger(limit) || limit < 1,
      )
    ) {
      throw new Error("Invalid durable quota limits");
    }
  }

  async reserve(rawReservation: QuotaReservation): Promise<boolean> {
    const reservation = quotaReservationSchema.parse(rawReservation);
    return this.write(async (ledger) => {
      await ledger.source.query(
        "SELECT pg_advisory_xact_lock(hashtext($1)) AS quota_lock",
        [`quota:${reservation.tenantId}:${reservation.resource}`],
      );
      await ledger.source.query(
        `UPDATE quota_ledger
            SET state = 'EXPIRED', updated_at = CURRENT_TIMESTAMP
          WHERE tenant_id = $1 AND resource = $2 AND state = 'RESERVED'
            AND expires_at <= CURRENT_TIMESTAMP`,
        [reservation.tenantId, reservation.resource],
      );
      const usage = await ledger.source.query<{ amount: number | string }>(
        `SELECT coalesce(sum(
           CASE WHEN state = 'COMMITTED' THEN actual_amount
                WHEN state = 'RESERVED' THEN reserved_amount ELSE 0 END
         ), 0) AS amount
           FROM quota_ledger
          WHERE tenant_id = $1 AND resource = $2
            AND state IN ('RESERVED', 'COMMITTED')
            AND window_end > CURRENT_TIMESTAMP`,
        [reservation.tenantId, reservation.resource],
      );
      const used = Number(usage.rows[0]?.amount ?? 0);
      if (
        !Number.isSafeInteger(used) ||
        used < 0 ||
        used + reservation.amount > ledger.limits[reservation.resource]
      ) {
        return false;
      }
      const result = await ledger.source.query<{ id: string }>(
        `INSERT INTO quota_ledger (
           tenant_id, id, case_id, job_id, resource, window_start, window_end,
           reserved_amount, expires_at, created_at, updated_at
         )
         SELECT $1, $2, $3, $4, $5, j.created_at, $6, $7, $6,
                j.created_at, j.created_at
           FROM jobs j
          WHERE j.tenant_id = $1 AND j.case_id = $3 AND j.id = $4
         ON CONFLICT (tenant_id, id) DO NOTHING
         RETURNING id`,
        [
          reservation.tenantId,
          reservation.reservationId,
          reservation.caseId,
          reservation.jobId,
          reservation.resource,
          reservation.expiresAt,
          reservation.amount,
        ],
      );
      return result.rows.length === 1;
    });
  }

  async commit(
    tenantId: string,
    reservationId: string,
    actualAmount: number,
  ): Promise<void> {
    const result = await this.source.query<{ id: string }>(
      `UPDATE quota_ledger
          SET state = 'COMMITTED', actual_amount = $3,
              updated_at = CURRENT_TIMESTAMP
        WHERE tenant_id = $1 AND id = $2 AND state = 'RESERVED'
          AND $3 >= 0 AND $3 <= reserved_amount
        RETURNING id`,
      [tenantId, reservationId, actualAmount],
    );
    if (!result.rows[0]) throw new QuotaReservationError();
  }

  async release(tenantId: string, reservationId: string): Promise<void> {
    const result = await this.source.query<{ id: string }>(
      `UPDATE quota_ledger
          SET state = 'RELEASED', updated_at = CURRENT_TIMESTAMP
        WHERE tenant_id = $1 AND id = $2 AND state = 'RESERVED'
        RETURNING id`,
      [tenantId, reservationId],
    );
    if (!result.rows[0]) throw new QuotaReservationError();
  }

  async releaseForJob(
    tenantId: string,
    jobId: string,
    releasedAt: string,
  ): Promise<number> {
    const at = canonicalTimestamp(releasedAt);
    if (
      !at ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(tenantId) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(jobId)
    ) {
      throw new QuotaReservationError();
    }
    const result = await this.source.query<{ id: string }>(
      `UPDATE quota_ledger
          SET state = 'RELEASED', updated_at = $3
        WHERE tenant_id = $1 AND job_id = $2
          AND resource = 'active-jobs' AND state = 'RESERVED'
        RETURNING id`,
      [tenantId, jobId, at],
    );
    return result.rows.length;
  }

  private async write<T>(
    operation: (ledger: PostgresQuotaLedger) => Promise<T>,
  ): Promise<T> {
    if (!isDatabase(this.source)) return operation(this);
    return runSerializableTransaction(this.source, (executor) =>
      operation(new PostgresQuotaLedger(executor, this.limits)),
    );
  }
}

export class PostgresAuditSink implements AuditSink {
  constructor(private readonly executor: PostgresExecutor) {}

  async append(rawEvent: AuditEvent): Promise<void> {
    const event = auditEventSchema.parse(rawEvent);
    await this.executor.query(
      `INSERT INTO audit_events (
         tenant_id, id, actor_id, action, target_type, target_id,
         outcome, metadata, occurred_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
      [
        event.tenantId,
        event.eventId,
        event.actorId,
        event.action,
        event.targetType,
        event.targetId,
        event.outcome,
        JSON.stringify(event.metadata),
        event.occurredAt,
      ],
    );
  }
}

function transactionPorts(
  executor: PostgresExecutor,
  quotaLimits: Partial<QuotaLimits>,
): TransactionPorts {
  return {
    audit: new PostgresAuditSink(executor),
    outbox: new PostgresOutbox(executor),
    quotas: new PostgresQuotaLedger(executor, quotaLimits),
    reproductions: new PostgresDurableReproductionRepository(executor),
  };
}

export class PostgresUnitOfWork implements UnitOfWork {
  constructor(
    private readonly database: PostgresDatabase,
    private readonly quotaLimits: Partial<QuotaLimits> = {},
  ) {}

  async run<T>(operation: (ports: TransactionPorts) => Promise<T>): Promise<T> {
    return runSerializableTransaction(this.database, (executor) =>
      operation(transactionPorts(executor, this.quotaLimits)),
    );
  }
}
