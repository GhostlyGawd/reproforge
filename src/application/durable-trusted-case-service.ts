import { createHash } from "node:crypto";

import {
  BundleNotReadyError,
  IdempotencyConflictError,
  ReproductionNotFoundError,
  TrustedExecutionFailedError,
  type CaseOperations,
} from "@/application/case-service";
import { DurableQueueConsumer } from "@/application/durable-queue-consumer";
import {
  DurableStartError,
  reserveDurableStart,
} from "@/application/durable-start";
import { OutboxPublisher } from "@/application/outbox-publisher";
import type {
  ArtifactDescriptor,
  ArtifactStore,
  DurableReproductionRecord,
  DurableReproductionRepository,
  JobQueue,
  Outbox,
  QueueMessage,
  TenantScope,
  UnitOfWork,
} from "@/application/ports/production";
import {
  exportResultSchema,
  getJobSchema,
  getReproductionSchema,
  jobSnapshotSchema,
  reproductionSnapshotSchema,
  startResultSchema,
  startTrustedReproductionSchema,
  type ExportResult,
  type GetJob,
  type GetReproduction,
  type JobSnapshot,
  type ReproductionSnapshot,
  type StartResult,
  type StartTrustedReproduction,
} from "@/application/reproduction-contracts";
import {
  runTrustedSample,
  type SampleCaseResult,
  type TrustedSampleOptions,
} from "@/application/sample-case";
import { canonicalJson, hashCanonical } from "@/domain/bundle";
import { createCase } from "@/domain/case";
import { createJob, transitionJob } from "@/domain/job";

type Clock = Readonly<{ now(): Date }>;

type DurableTrustedCaseServiceDependencies = Readonly<{
  artifactStore: ArtifactStore;
  clock: Clock;
  executeTrustedSample?: (
    options?: TrustedSampleOptions,
  ) => Promise<SampleCaseResult>;
  identifiers: Readonly<{
    nextCaseId(): string;
    nextJobId(): string;
    nextWorkerOwnerId(): string;
  }>;
  leaseSeconds: number;
  outbox: Outbox;
  outboxPolicy: Readonly<{
    claimSeconds: number;
    maxAttempts: number;
    maxBatchSize: number;
    ownerId: string;
  }>;
  queue: JobQueue;
  repository: DurableReproductionRepository;
  retentionDays: number;
  tenantId: string;
  unitOfWork: UnitOfWork;
}>;

type BundlePayload = Readonly<{
  bundle: NonNullable<ReproductionSnapshot["result"]>["bundle"];
  files: NonNullable<ReproductionSnapshot["result"]>["files"];
  schemaVersion: "1.0";
}>;

function derivedId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${createHash("sha256")
    .update(parts.join("\u0000"))
    .digest("hex")
    .slice(0, 48)}`;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function bundlePayload(result: SampleCaseResult): BundlePayload {
  return {
    bundle: result.bundle,
    files: result.files,
    schemaVersion: "1.0",
  };
}

function bundlePayloadBytes(result: SampleCaseResult): Uint8Array {
  return new TextEncoder().encode(canonicalJson(bundlePayload(result)));
}

function bundleArtifactDescriptor(input: {
  bytes: Uint8Array;
  caseId: string;
  createdAt: string;
  retentionDays: number;
  tenantId: string;
}): ArtifactDescriptor {
  const digest = sha256(input.bytes);
  return {
    artifactId: derivedId("artifact", input.tenantId, input.caseId, digest),
    byteCount: input.bytes.byteLength,
    caseId: input.caseId,
    createdAt: input.createdAt,
    kind: "bundle",
    objectKey: [
      "tenants",
      input.tenantId,
      "cases",
      input.caseId,
      "bundle",
      digest,
    ].join("/"),
    retentionUntil: new Date(
      Date.parse(input.createdAt) + input.retentionDays * 86_400_000,
    ).toISOString(),
    sha256: digest,
    tenantId: input.tenantId,
  };
}

function messageFor(record: DurableReproductionRecord): QueueMessage {
  return {
    caseId: record.caseId,
    eventId: `outbox_${record.caseId}`,
    jobId: record.jobId,
    kind: "reproduction.requested",
    schemaVersion: "1.0",
    tenantId: record.tenantId,
  };
}

function scope(tenantId: string, callerId: string): TenantScope {
  return { callerId, principalId: callerId, tenantId };
}

function isTerminal(record: DurableReproductionRecord): boolean {
  return ["CANCELLED", "FAILED", "SUCCEEDED"].includes(
    record.snapshot.job.state,
  );
}

function completedAt(record: DurableReproductionRecord, clock: Clock): Date {
  return new Date(
    Math.max(
      clock.now().getTime(),
      Date.parse(record.snapshot.job.updatedAt),
      Date.parse(record.snapshot.case.updatedAt),
    ),
  );
}

class TrustedFixtureDurableWorker {
  constructor(
    private readonly artifactStore: ArtifactStore,
    private readonly clock: Clock,
    private readonly executeTrustedSample: (
      options?: TrustedSampleOptions,
    ) => Promise<SampleCaseResult>,
    private readonly retentionDays: number,
  ) {}

  async execute(input: {
    record: DurableReproductionRecord;
  }): Promise<DurableReproductionRecord> {
    const { record } = input;
    const result = await this.executeTrustedSample({
      ...(record.requestedBudget
        ? { budget: record.requestedBudget }
        : {}),
      caseId: record.caseId,
      startedAt: new Date(record.createdAt),
    });
    const bytes = bundlePayloadBytes(result);
    await this.artifactStore.put({
      bytes,
      descriptor: bundleArtifactDescriptor({
        bytes,
        caseId: record.caseId,
        createdAt: record.createdAt,
        retentionDays: this.retentionDays,
        tenantId: record.tenantId,
      }),
    });
    const at = completedAt(
      {
        ...record,
        snapshot: { ...record.snapshot, case: result.case },
      },
      this.clock,
    );
    return {
      ...record,
      snapshot: {
        ...record.snapshot,
        case: result.case,
        job: transitionJob(record.snapshot.job, "SUCCEEDED", {
          at,
          progressPhase: result.case.state,
        }),
        result,
      },
      updatedAt: at.toISOString(),
    };
  }
}

export class DurableTrustedCaseService implements CaseOperations {
  private readonly consumer: DurableQueueConsumer;
  private readonly executeTrustedSample: (
    options?: TrustedSampleOptions,
  ) => Promise<SampleCaseResult>;
  private readonly publisher: OutboxPublisher;

  constructor(
    private readonly dependencies: DurableTrustedCaseServiceDependencies,
  ) {
    if (
      !Number.isInteger(dependencies.retentionDays) ||
      dependencies.retentionDays < 1 ||
      dependencies.retentionDays > 365
    ) {
      throw new Error("Invalid trusted fixture retention policy");
    }
    this.executeTrustedSample =
      dependencies.executeTrustedSample ?? runTrustedSample;
    this.publisher = new OutboxPublisher({
      claimSeconds: dependencies.outboxPolicy.claimSeconds,
      clock: dependencies.clock,
      maxAttempts: dependencies.outboxPolicy.maxAttempts,
      maxBatchSize: dependencies.outboxPolicy.maxBatchSize,
      outbox: dependencies.outbox,
      ownerId: dependencies.outboxPolicy.ownerId,
      queue: dependencies.queue,
    });
    this.consumer = new DurableQueueConsumer({
      clock: dependencies.clock,
      leaseSeconds: dependencies.leaseSeconds,
      repository: dependencies.repository,
      worker: new TrustedFixtureDurableWorker(
        dependencies.artifactStore,
        dependencies.clock,
        this.executeTrustedSample,
        dependencies.retentionDays,
      ),
    });
  }

  async startTrustedReproduction(
    rawCommand: StartTrustedReproduction,
  ): Promise<StartResult> {
    const command = startTrustedReproductionSchema.parse(rawCommand);
    const commandHash = await hashCanonical({
      budget: command.budget,
      sampleId: command.sampleId,
    });
    const tenantScope = scope(this.dependencies.tenantId, command.callerId);
    const existing = await this.dependencies.repository.findByIdempotencyKey(
      tenantScope,
      command.idempotencyKey,
    );
    if (existing) {
      if (existing.commandHash !== commandHash) {
        throw new IdempotencyConflictError();
      }
      const record = isTerminal(existing)
        ? existing
        : await this.publishAndConsume(existing, false);
      return startResultSchema.parse({
        reused: true,
        snapshot: record.snapshot,
      });
    }

    const createdAt = this.dependencies.clock.now();
    const caseId = this.dependencies.identifiers.nextCaseId();
    const jobId = this.dependencies.identifiers.nextJobId();
    const record: DurableReproductionRecord = {
      callerId: command.callerId,
      caseId,
      commandHash,
      createdAt: createdAt.toISOString(),
      idempotencyKey: command.idempotencyKey,
      jobId,
      requestedBudget: command.budget,
      snapshot: {
        case: createCase(caseId, createdAt),
        job: createJob(jobId, caseId, createdAt),
        result: null,
        sampleId: command.sampleId,
        schemaVersion: "2.0",
      },
      tenantId: this.dependencies.tenantId,
      updatedAt: createdAt.toISOString(),
      version: 1,
    };
    const queueMessage = messageFor(record);
    let reservation;
    try {
      reservation = await reserveDurableStart(this.dependencies.unitOfWork, {
        auditEvent: {
          action: "case.created",
          actorId: record.callerId,
          eventId: derivedId("audit", record.tenantId, record.caseId),
          metadata: { sampleKind: "trusted-sample" },
          occurredAt: record.createdAt,
          outcome: "success",
          targetId: record.caseId,
          targetType: "case",
          tenantId: record.tenantId,
        },
        outboxMessage: queueMessage,
        quotaReservation: {
          amount: 1,
          caseId: record.caseId,
          expiresAt: new Date(createdAt.getTime() + 15 * 60_000).toISOString(),
          jobId: record.jobId,
          reservationId: derivedId(
            "quota",
            record.tenantId,
            record.caseId,
          ),
          resource: "active-jobs",
          tenantId: record.tenantId,
        },
        record,
      });
    } catch (error) {
      if (
        error instanceof DurableStartError &&
        error.code === "IDEMPOTENCY_CONFLICT"
      ) {
        throw new IdempotencyConflictError();
      }
      throw new TrustedExecutionFailedError();
    }
    if (reservation.record.commandHash !== commandHash) {
      throw new IdempotencyConflictError();
    }
    const completed = isTerminal(reservation.record)
      ? reservation.record
      : await this.publishAndConsume(
          reservation.record,
          reservation.created,
        );
    return startResultSchema.parse({
      reused: !reservation.created,
      snapshot: completed.snapshot,
    });
  }

  async getReproduction(
    rawQuery: GetReproduction,
  ): Promise<ReproductionSnapshot> {
    const query = getReproductionSchema.parse(rawQuery);
    const record = await this.dependencies.repository.findByCaseId(
      scope(this.dependencies.tenantId, query.callerId),
      query.caseId,
    );
    if (!record) throw new ReproductionNotFoundError();
    return reproductionSnapshotSchema.parse(record.snapshot);
  }

  async getJob(rawQuery: GetJob): Promise<JobSnapshot> {
    const query = getJobSchema.parse(rawQuery);
    const record = await this.dependencies.repository.findByJobId(
      scope(this.dependencies.tenantId, query.callerId),
      query.jobId,
    );
    if (!record) throw new ReproductionNotFoundError();
    return jobSnapshotSchema.parse({
      job: record.snapshot.job,
      schemaVersion: "2.0",
    });
  }

  async exportReproBundle(rawQuery: GetReproduction): Promise<ExportResult> {
    const query = getReproductionSchema.parse(rawQuery);
    const snapshot = await this.getReproduction(query);
    if (
      !snapshot.result ||
      "kind" in snapshot.result ||
      snapshot.result.summary.status !== "VERIFIED" ||
      !snapshot.result.bundle
    ) {
      throw new BundleNotReadyError();
    }
    const bytes = bundlePayloadBytes(snapshot.result);
    const descriptor = bundleArtifactDescriptor({
      bytes,
      caseId: snapshot.case.id,
      createdAt: snapshot.case.createdAt,
      retentionDays: this.dependencies.retentionDays,
      tenantId: this.dependencies.tenantId,
    });
    const stored = await this.dependencies.artifactStore.read(
      scope(this.dependencies.tenantId, query.callerId),
      descriptor.artifactId,
    );
    if (
      !stored ||
      new TextDecoder().decode(stored.bytes) !==
        new TextDecoder().decode(bytes)
    ) {
      throw new BundleNotReadyError();
    }
    return exportResultSchema.parse({
      bundle: snapshot.result.bundle,
      caseId: snapshot.case.id,
      files: snapshot.result.files,
      schemaVersion: "2.0",
    });
  }

  private async publishAndConsume(
    record: DurableReproductionRecord,
    requireNewDelivery: boolean,
  ): Promise<DurableReproductionRecord> {
    const published = await this.publisher.publishBatch();
    if (
      published.dead > 0 ||
      published.retryScheduled > 0 ||
      (requireNewDelivery && published.delivered < 1)
    ) {
      throw new TrustedExecutionFailedError();
    }
    const outcome = await this.consumer.consume(
      messageFor(record),
      this.dependencies.identifiers.nextWorkerOwnerId(),
    );
    if (
      outcome.outcome === "cancelled" ||
      outcome.outcome === "exhausted" ||
      outcome.outcome === "requeued"
    ) {
      throw new TrustedExecutionFailedError();
    }
    const stored = await this.dependencies.repository.findByIdempotencyKey(
      scope(record.tenantId, record.callerId),
      record.idempotencyKey,
    );
    if (!stored) throw new ReproductionNotFoundError();
    return stored;
  }
}
