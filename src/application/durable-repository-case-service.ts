import { createHash } from "node:crypto";

import { z } from "zod";

import type { AuthorizedPrincipal } from "@/application/authorization";
import {
  BundleNotReadyError,
  CaseServiceError,
  IdempotencyConflictError,
  ReproductionNotFoundError,
} from "@/application/case-service";
import {
  DurableQueueConsumer,
  type DurableWorker,
} from "@/application/durable-queue-consumer";
import { DurableStartError, reserveDurableStart } from "@/application/durable-start";
import { OutboxPublisher } from "@/application/outbox-publisher";
import type {
  ArtifactStore,
  DurableReproductionRecord,
  DurableReproductionRepository,
  JobQueue,
  Outbox,
  QueueMessage,
  TenantScope,
  UnitOfWork,
} from "@/application/ports/production";
import type { RepositorySourceProvider } from "@/application/ports/repository-source";
import {
  repositoryBundleBytes,
  repositoryBundleDescriptor,
  RepositoryDurableWorker,
} from "@/application/repository-durable-worker";
import {
  startRepositoryReproductionInputSchema,
  type ListAuthorizedRepositoriesInput,
  type RepositoryOperations,
  type StartRepositoryReproductionInput,
} from "@/application/repository-operations";
import {
  exportResultSchema,
  reproductionSnapshotSchema,
  startResultSchema,
} from "@/application/reproduction-contracts";
import { canonicalJson, hashCanonical } from "@/domain/bundle";
import { createCase } from "@/domain/case";
import { createJob } from "@/domain/job";
import {
  resolvedRepositoryExecutionRequestSchema,
  type ResolvedRepositoryExecutionRequest,
} from "@/execution/contracts";
import type { IsolatedRepositoryRunner } from "@/execution/isolated-repository-runner";
import { resolveImmutableRepositorySource } from "@/execution/source-provenance";

type Clock = Readonly<{ now(): Date }>;

type Dependencies = Readonly<{
  artifactStore: ArtifactStore;
  cancellationPollMs?: number;
  clock: Clock;
  executionMode?: "inline" | "queued";
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
  runner: Pick<IsolatedRepositoryRunner, "execute">;
  source: RepositorySourceProvider;
  unitOfWork: UnitOfWork;
}>;

function scope(principal: AuthorizedPrincipal): TenantScope {
  return {
    callerId: principal.callerId,
    principalId: principal.principalId,
    tenantId: principal.tenantId,
  };
}

function derivedId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${createHash("sha256")
    .update(parts.join("\u0000"))
    .digest("hex")
    .slice(0, 48)}`;
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

function terminal(record: DurableReproductionRecord): boolean {
  return ["CANCELLED", "FAILED", "SUCCEEDED"].includes(
    record.snapshot.job.state,
  );
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function executionFailure(): CaseServiceError {
  return new CaseServiceError(
    "INTERNAL_ERROR",
    "The repository reproduction failed safely",
    true,
  );
}

function requestFor(
  record: DurableReproductionRecord,
): ResolvedRepositoryExecutionRequest {
  const parsed = resolvedRepositoryExecutionRequestSchema.safeParse(
    record.repositoryRequest,
  );
  if (!parsed.success) throw executionFailure();
  return parsed.data;
}

export class DurableRepositoryCaseService implements RepositoryOperations {
  private readonly cancellationPollMs: number;
  private readonly consumer: DurableQueueConsumer;
  private readonly executionMode: "inline" | "queued";
  private readonly publisher: OutboxPublisher;
  private readonly worker: RepositoryDurableWorker;

  constructor(private readonly dependencies: Dependencies) {
    if (
      !Number.isInteger(dependencies.retentionDays) ||
      dependencies.retentionDays < 1 ||
      dependencies.retentionDays > 365
    ) {
      throw executionFailure();
    }
    this.cancellationPollMs = z
      .number()
      .int()
      .min(10)
      .max(60_000)
      .parse(dependencies.cancellationPollMs ?? 1_000);
    this.executionMode = dependencies.executionMode ?? "inline";
    this.publisher = new OutboxPublisher({
      claimSeconds: dependencies.outboxPolicy.claimSeconds,
      clock: dependencies.clock,
      maxAttempts: dependencies.outboxPolicy.maxAttempts,
      maxBatchSize: dependencies.outboxPolicy.maxBatchSize,
      outbox: dependencies.outbox,
      ownerId: dependencies.outboxPolicy.ownerId,
      queue: dependencies.queue,
    });
    this.worker = new RepositoryDurableWorker({
      artifactStore: dependencies.artifactStore,
      clock: dependencies.clock,
      execute: async ({ lease, record }) => {
        const request = requestFor(record);
        const controller = new AbortController();
        let checking = false;
        let stopped = false;
        const checkCancellation = async () => {
          if (checking || stopped || controller.signal.aborted) return;
          checking = true;
          try {
            if (await dependencies.repository.isCancellationRequested(lease)) {
              controller.abort();
            }
          } catch {
            controller.abort();
          } finally {
            checking = false;
          }
        };
        await checkCancellation();
        const cancellationTimer = setInterval(
          () => void checkCancellation(),
          this.cancellationPollMs,
        );
        try {
          return await dependencies.runner.execute({
            attemptId: `${record.jobId}.attempt-${lease.attempt}`,
            budget:
              record.requestedBudget ?? {
                maxToolCalls: 6,
                requiredRuns: 3,
              },
            case: record.snapshot.case,
            issueEvidence: request.issueEvidence,
            oracle: request.oracle,
            principal: {
              callerId: record.callerId,
              principalId: record.callerId,
              tenantId: record.tenantId,
            },
            profile: request.profile,
            signal: controller.signal,
            source: request.source,
          });
        } finally {
          stopped = true;
          clearInterval(cancellationTimer);
        }
      },
      retentionDays: dependencies.retentionDays,
    });
    this.consumer = new DurableQueueConsumer({
      clock: dependencies.clock,
      leaseSeconds: dependencies.leaseSeconds,
      repository: dependencies.repository,
      worker: this.worker,
    });
  }

  async listAuthorizedRepositories(
    principal: AuthorizedPrincipal,
    input: ListAuthorizedRepositoriesInput,
  ) {
    const listed = await this.dependencies.source.listAuthorizedRepositories(
      principal,
      input,
    );
    if (listed.tenantId !== principal.tenantId) throw new ReproductionNotFoundError();
    return listed;
  }

  async startRepositoryReproduction(
    principal: AuthorizedPrincipal,
    rawInput: StartRepositoryReproductionInput,
  ) {
    const input = startRepositoryReproductionInputSchema.parse(rawInput);
    const immutableSource = await resolveImmutableRepositorySource(
      this.dependencies.source,
      principal,
      {
        commitSha: input.source.commitSha,
        repositoryId: input.source.repositoryId,
      },
    );
    const repositoryRequest = resolvedRepositoryExecutionRequestSchema.parse({
      issueEvidence: input.source.issueEvidence,
      oracle: input.source.failureOracle,
      profile: input.source.executionProfile,
      source: immutableSource,
    });
    const commandHash = await hashCanonical({
      budget: input.budget,
      repositoryRequest,
    });
    const tenantScope = scope(principal);
    const existing = await this.dependencies.repository.findByIdempotencyKey(
      tenantScope,
      input.idempotencyKey,
    );
    if (existing) {
      if (existing.commandHash !== commandHash) throw new IdempotencyConflictError();
      const record = terminal(existing)
        ? existing
        : await this.publishAndMaybeConsume(existing, false);
      return startResultSchema.parse({ reused: true, snapshot: record.snapshot });
    }

    const createdAt = this.dependencies.clock.now();
    const caseId = this.dependencies.identifiers.nextCaseId();
    const jobId = this.dependencies.identifiers.nextJobId();
    const record: DurableReproductionRecord = {
      callerId: principal.callerId,
      caseId,
      commandHash,
      createdAt: createdAt.toISOString(),
      idempotencyKey: input.idempotencyKey,
      jobId,
      repositoryRequest,
      requestedBudget: input.budget,
      snapshot: {
        case: createCase(caseId, createdAt),
        job: createJob(jobId, caseId, createdAt),
        repositorySource: immutableSource,
        result: null,
        schemaVersion: "2.0",
      },
      tenantId: principal.tenantId,
      updatedAt: createdAt.toISOString(),
      version: 1,
    };
    let reservation;
    try {
      reservation = await reserveDurableStart(this.dependencies.unitOfWork, {
        auditEvent: {
          action: "case.created",
          actorId: principal.principalId,
          eventId: derivedId("audit", record.tenantId, record.caseId),
          metadata: {
            provider: "github",
            repositoryId: immutableSource.repositoryId,
          },
          occurredAt: record.createdAt,
          outcome: "success",
          targetId: record.caseId,
          targetType: "case",
          tenantId: record.tenantId,
        },
        outboxMessage: messageFor(record),
        quotaReservation: {
          amount: 1,
          caseId: record.caseId,
          expiresAt: new Date(createdAt.getTime() + 15 * 60_000).toISOString(),
          jobId: record.jobId,
          reservationId: derivedId("quota", record.tenantId, record.caseId),
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
      throw executionFailure();
    }
    if (reservation.record.commandHash !== commandHash) {
      throw new IdempotencyConflictError();
    }
    const completed = terminal(reservation.record)
      ? reservation.record
      : await this.publishAndMaybeConsume(
          reservation.record,
          reservation.created,
        );
    return startResultSchema.parse({
      reused: !reservation.created,
      snapshot: completed.snapshot,
    });
  }

  async getReproduction(
    principal: AuthorizedPrincipal,
    input: { caseId: string },
  ) {
    const record = await this.dependencies.repository.findByCaseId(
      scope(principal),
      input.caseId,
    );
    if (!record || !record.snapshot.repositorySource) {
      throw new ReproductionNotFoundError();
    }
    return reproductionSnapshotSchema.parse(record.snapshot);
  }

  async cancelReproduction(
    principal: AuthorizedPrincipal,
    input: { jobId: string },
  ) {
    const cancelled = await this.dependencies.repository.requestCancellation(
      scope(principal),
      input.jobId,
      this.dependencies.clock.now().toISOString(),
    );
    if (!cancelled) throw new ReproductionNotFoundError();
    return cancelled;
  }

  async exportReproBundle(
    principal: AuthorizedPrincipal,
    input: { caseId: string },
  ) {
    const snapshot = await this.getReproduction(principal, input);
    const result = snapshot.result;
    if (
      !result ||
      !("kind" in result) ||
      !result.bundle ||
      result.summary.status !== "VERIFIED"
    ) {
      throw new BundleNotReadyError();
    }
    const bytes = repositoryBundleBytes(result);
    const descriptor = repositoryBundleDescriptor({
      bytes,
      caseId: snapshot.case.id,
      createdAt: snapshot.case.createdAt,
      retentionDays: this.dependencies.retentionDays,
      tenantId: principal.tenantId,
    });
    const stored = await this.dependencies.artifactStore.read(
      scope(principal),
      descriptor.artifactId,
    );
    if (
      !stored ||
      !bytesEqual(stored.bytes, bytes) ||
      canonicalJson(stored.descriptor) !== canonicalJson(descriptor)
    ) {
      throw new BundleNotReadyError();
    }
    return exportResultSchema.parse({
      bundle: result.bundle,
      caseId: snapshot.case.id,
      files: result.files,
      schemaVersion: "2.0",
    });
  }

  consumeQueueMessage(message: QueueMessage, ownerId: string) {
    return this.consumer.consume(message, ownerId);
  }

  executeClaimedWork(input: Parameters<DurableWorker["execute"]>[0]) {
    return this.worker.execute(input);
  }

  publishPending() {
    return this.publisher.publishBatch();
  }

  private async publishAndMaybeConsume(
    record: DurableReproductionRecord,
    requireNewDelivery: boolean,
  ): Promise<DurableReproductionRecord> {
    const published = await this.publisher.publishBatch();
    if (
      published.dead > 0 ||
      published.retryScheduled > 0 ||
      (requireNewDelivery && published.delivered < 1)
    ) {
      throw executionFailure();
    }
    if (this.executionMode === "queued") {
      const queued = await this.dependencies.repository.findByIdempotencyKey(
        {
          callerId: record.callerId,
          principalId: record.callerId,
          tenantId: record.tenantId,
        },
        record.idempotencyKey,
      );
      if (!queued) throw new ReproductionNotFoundError();
      return queued;
    }
    const outcome = await this.consumer.consume(
      messageFor(record),
      this.dependencies.identifiers.nextWorkerOwnerId(),
    );
    if (outcome.outcome !== "completed" && outcome.outcome !== "ignored") {
      throw executionFailure();
    }
    const stored = await this.dependencies.repository.findByIdempotencyKey(
      {
        callerId: record.callerId,
        principalId: record.callerId,
        tenantId: record.tenantId,
      },
      record.idempotencyKey,
    );
    if (!stored) throw new ReproductionNotFoundError();
    return stored;
  }
}
