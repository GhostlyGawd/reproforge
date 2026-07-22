import { z } from "zod";

import type { ReproductionSnapshot } from "@/application/reproduction-contracts";
import type { ResolvedRepositoryExecutionRequest } from "@/execution/contracts";

const opaqueIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const timestampSchema = z.string().datetime();

export const tenantScopeSchema = z
  .object({
    callerId: opaqueIdSchema,
    principalId: opaqueIdSchema,
    tenantId: opaqueIdSchema,
  })
  .strict();

export const queueMessageSchema = z
  .object({
    caseId: opaqueIdSchema,
    eventId: opaqueIdSchema,
    jobId: opaqueIdSchema,
    kind: z.enum([
      "reproduction.requested",
      "reproduction.cancelled",
      "reproduction.recovery-requested",
      "retention.deletion-requested",
    ]),
    schemaVersion: z.literal("1.0"),
    tenantId: opaqueIdSchema,
  })
  .strict();

export const artifactKindSchema = z.enum([
  "source",
  "run-log",
  "run-output",
  "bundle",
  "backup-manifest",
]);

export const artifactDescriptorSchema = z
  .object({
    artifactId: opaqueIdSchema,
    byteCount: z.number().int().nonnegative().max(1_073_741_824),
    caseId: opaqueIdSchema,
    createdAt: timestampSchema,
    kind: artifactKindSchema,
    objectKey: z.string().min(1).max(512),
    retentionUntil: timestampSchema,
    sha256: sha256Schema,
    tenantId: opaqueIdSchema,
  })
  .strict()
  .superRefine((descriptor, context) => {
    const expectedKey = [
      "tenants",
      descriptor.tenantId,
      "cases",
      descriptor.caseId,
      descriptor.kind,
      descriptor.sha256,
    ].join("/");
    if (descriptor.objectKey !== expectedKey) {
      context.addIssue({
        code: "custom",
        message: "objectKey must be tenant-scoped and content-addressed",
        path: ["objectKey"],
      });
    }
    if (
      Date.parse(descriptor.retentionUntil) <= Date.parse(descriptor.createdAt)
    ) {
      context.addIssue({
        code: "custom",
        message: "retentionUntil must be after createdAt",
        path: ["retentionUntil"],
      });
    }
  });

export const jobLeaseSchema = z
  .object({
    acquiredAt: timestampSchema,
    attempt: z.number().int().positive().max(100),
    expiresAt: timestampSchema,
    jobId: opaqueIdSchema,
    ownerId: opaqueIdSchema,
    tenantId: opaqueIdSchema,
  })
  .strict()
  .refine(
    (lease) => Date.parse(lease.expiresAt) > Date.parse(lease.acquiredAt),
    { message: "expiresAt must be after acquiredAt", path: ["expiresAt"] },
  );

const auditMetadataValueSchema = z.union([
  z.string().max(512),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
const forbiddenAuditKey =
  /(authorization|cookie|credential|password|secret|source|token|command)/i;

export const auditEventSchema = z
  .object({
    action: z.string().min(1).max(96).regex(/^[a-z][a-z0-9.-]*$/),
    actorId: opaqueIdSchema,
    eventId: opaqueIdSchema,
    metadata: z
      .record(z.string().min(1).max(64), auditMetadataValueSchema)
      .superRefine((metadata, context) => {
        for (const key of Object.keys(metadata)) {
          if (forbiddenAuditKey.test(key)) {
            context.addIssue({
              code: "custom",
              message: "audit metadata key is not allowed",
              path: [key],
            });
          }
        }
      }),
    occurredAt: timestampSchema,
    outcome: z.enum(["success", "denied", "failure"]),
    targetId: opaqueIdSchema,
    targetType: z.enum([
      "account",
      "artifact",
      "case",
      "installation",
      "job",
      "repository",
    ]),
    tenantId: opaqueIdSchema,
  })
  .strict();

export const quotaReservationSchema = z
  .object({
    amount: z.number().int().positive(),
    caseId: opaqueIdSchema,
    expiresAt: timestampSchema,
    jobId: opaqueIdSchema,
    reservationId: opaqueIdSchema,
    resource: z.enum([
      "active-jobs",
      "artifact-bytes",
      "cpu-milliseconds",
      "exports",
    ]),
    tenantId: opaqueIdSchema,
  })
  .strict();

export type TenantScope = z.infer<typeof tenantScopeSchema>;
export type QueueMessage = z.infer<typeof queueMessageSchema>;
export type ArtifactDescriptor = z.infer<typeof artifactDescriptorSchema>;
export type JobLease = z.infer<typeof jobLeaseSchema>;
export type AuditEvent = z.infer<typeof auditEventSchema>;
export type QuotaReservation = z.infer<typeof quotaReservationSchema>;

export type DurableReproductionRecord = {
  callerId: string;
  caseId: string;
  commandHash: string;
  createdAt: string;
  idempotencyKey: string;
  jobId: string;
  requestedBudget?: {
    maxToolCalls: number;
    requiredRuns: number;
  };
  repositoryRequest?: ResolvedRepositoryExecutionRequest;
  snapshot: ReproductionSnapshot;
  tenantId: string;
  updatedAt: string;
  version: number;
};

export type DurableReservationResult =
  | { created: true; record: DurableReproductionRecord }
  | { created: false; record: DurableReproductionRecord };

export type LeaseFailure = Readonly<{
  at: string;
  code: string;
  nextAttemptAt: string;
  retryable: boolean;
}>;

export type LeaseFailureDisposition = "cancelled" | "exhausted" | "requeued";

export type LeaseRecoverySummary = Readonly<{
  cancelled: number;
  exhausted: number;
  requeued: number;
}>;

export type CancellationRequestResult = Readonly<{
  caseId: string;
  changed: boolean;
  disposition: "cancelled" | "requested";
}>;

export type OutboxClaim = Readonly<{
  claimedAt: string;
  claimExpiresAt: string;
  claimOwnerId: string;
  deliveryAttempt: number;
  message: QueueMessage;
  version: number;
}>;

export type OutboxFailureDisposition = "dead" | "lost" | "retry";

export interface DurableReproductionRepository {
  findByCaseId(
    scope: TenantScope,
    caseId: string,
  ): Promise<DurableReproductionRecord | null>;
  findByIdempotencyKey(
    scope: TenantScope,
    idempotencyKey: string,
  ): Promise<DurableReproductionRecord | null>;
  findByJobId(
    scope: TenantScope,
    jobId: string,
  ): Promise<DurableReproductionRecord | null>;
  reserve(record: DurableReproductionRecord): Promise<DurableReservationResult>;
  save(
    record: DurableReproductionRecord,
    expectedVersion: number,
  ): Promise<DurableReproductionRecord>;
  claimLease(input: {
    at: string;
    jobId: string;
    leaseSeconds: number;
    ownerId: string;
    tenantId: string;
  }): Promise<JobLease | null>;
  renewLease(
    lease: JobLease,
    input: { at: string; expiresAt: string },
  ): Promise<JobLease>;
  releaseLease(
    lease: JobLease,
    input: { at: string; nextAttemptAt: string },
  ): Promise<void>;
  findByLease(lease: JobLease): Promise<DurableReproductionRecord | null>;
  completeLease(
    lease: JobLease,
    record: DurableReproductionRecord,
  ): Promise<DurableReproductionRecord>;
  failLease(
    lease: JobLease,
    failure: LeaseFailure,
  ): Promise<LeaseFailureDisposition>;
  recoverExpiredLeases(input: {
    at: string;
    limit: number;
  }): Promise<LeaseRecoverySummary>;
  requestCancellation(
    scope: TenantScope,
    jobId: string,
    at: string,
  ): Promise<CancellationRequestResult | null>;
  isCancellationRequested(lease: JobLease): Promise<boolean>;
  cancelLease(
    lease: JobLease,
    input: { at: string },
  ): Promise<DurableReproductionRecord>;
}

export interface ArtifactStore {
  put(input: {
    bytes: Uint8Array;
    descriptor: ArtifactDescriptor;
  }): Promise<ArtifactDescriptor>;
  read(
    scope: TenantScope,
    artifactId: string,
  ): Promise<{ bytes: Uint8Array; descriptor: ArtifactDescriptor } | null>;
  delete(scope: TenantScope, artifactId: string): Promise<boolean>;
}

export interface JobQueue {
  send(message: QueueMessage): Promise<{ messageId: string | null }>;
}

export interface Outbox {
  append(message: QueueMessage): Promise<void>;
  claimPending(input: {
    at: string;
    claimSeconds: number;
    limit: number;
    ownerId: string;
  }): Promise<OutboxClaim[]>;
  markDelivered(
    claim: OutboxClaim,
    input: { deliveredAt: string; providerMessageId: string | null },
  ): Promise<boolean>;
  recordFailure(
    claim: OutboxClaim,
    input: {
      errorCode: string;
      failedAt: string;
      maxAttempts: number;
      nextAttemptAt: string;
    },
  ): Promise<OutboxFailureDisposition>;
}

export interface QuotaLedger {
  reserve(reservation: QuotaReservation): Promise<boolean>;
  commit(
    tenantId: string,
    reservationId: string,
    actualAmount: number,
  ): Promise<void>;
  release(tenantId: string, reservationId: string): Promise<void>;
  releaseForJob(tenantId: string, jobId: string, at: string): Promise<number>;
}

export interface AuditSink {
  append(event: AuditEvent): Promise<void>;
}

export type TransactionPorts = {
  audit: AuditSink;
  outbox: Outbox;
  quotas: QuotaLedger;
  reproductions: DurableReproductionRepository;
};

export interface UnitOfWork {
  run<T>(operation: (ports: TransactionPorts) => Promise<T>): Promise<T>;
}
