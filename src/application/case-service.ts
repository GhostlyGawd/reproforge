import { hashCanonical } from "@/domain/bundle";
import { createCase } from "@/domain/case";
import { createJob, transitionJob } from "@/domain/job";
import type {
  ReproductionRepository,
  StoredReproduction,
} from "@/infrastructure/reproduction-repository";

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
} from "./reproduction-contracts";
import {
  runTrustedSample,
  type SampleCaseResult,
  type TrustedSampleOptions,
} from "./sample-case";

export type CaseServiceErrorCode =
  | "BUNDLE_NOT_READY"
  | "IDEMPOTENCY_CONFLICT"
  | "INTERNAL_ERROR"
  | "NOT_FOUND";

export class CaseServiceError extends Error {
  constructor(
    readonly code: CaseServiceErrorCode,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "CaseServiceError";
  }
}

export class IdempotencyConflictError extends CaseServiceError {
  constructor() {
    super(
      "IDEMPOTENCY_CONFLICT",
      "The idempotency key was already used for a different request",
      false,
    );
    this.name = "IdempotencyConflictError";
  }
}

export class ReproductionNotFoundError extends CaseServiceError {
  constructor() {
    super("NOT_FOUND", "The requested reproduction was not found", false);
    this.name = "ReproductionNotFoundError";
  }
}

export class BundleNotReadyError extends CaseServiceError {
  constructor() {
    super("BUNDLE_NOT_READY", "The Repro Bundle is not ready", true);
    this.name = "BundleNotReadyError";
  }
}

export class TrustedExecutionFailedError extends CaseServiceError {
  constructor() {
    super("INTERNAL_ERROR", "The trusted reproduction failed safely", true);
    this.name = "TrustedExecutionFailedError";
  }
}

type CaseServiceDependencies = {
  clock: { now(): Date };
  executeTrustedSample?: (
    options?: TrustedSampleOptions,
  ) => Promise<SampleCaseResult>;
  identifiers: {
    nextCaseId(): string;
    nextJobId(): string;
  };
  repository: ReproductionRepository;
};

export interface CaseOperations {
  exportReproBundle(rawQuery: GetReproduction): Promise<ExportResult>;
  getJob(rawQuery: GetJob): Promise<JobSnapshot>;
  getReproduction(
    rawQuery: GetReproduction,
  ): Promise<ReproductionSnapshot>;
  startTrustedReproduction(
    rawCommand: StartTrustedReproduction,
  ): Promise<StartResult>;
}

function toSnapshot(record: StoredReproduction): ReproductionSnapshot {
  return reproductionSnapshotSchema.parse({
    case: record.case,
    job: record.job,
    result: record.result,
    sampleId: record.sampleId,
    schemaVersion: "2.0",
  });
}

export class CaseService implements CaseOperations {
  private readonly executeTrustedSample: (
    options?: TrustedSampleOptions,
  ) => Promise<SampleCaseResult>;

  constructor(private readonly dependencies: CaseServiceDependencies) {
    this.executeTrustedSample =
      dependencies.executeTrustedSample ?? runTrustedSample;
  }

  async startTrustedReproduction(
    rawCommand: StartTrustedReproduction,
  ): Promise<StartResult> {
    const command = startTrustedReproductionSchema.parse(rawCommand);
    const commandHash = await hashCanonical({
      budget: command.budget,
      sampleId: command.sampleId,
    });
    const existing = await this.dependencies.repository.findByIdempotencyKey(
      command.callerId,
      command.idempotencyKey,
    );
    if (existing) {
      if (existing.commandHash !== commandHash) {
        throw new IdempotencyConflictError();
      }
      return startResultSchema.parse({
        reused: true,
        snapshot: toSnapshot(existing),
      });
    }

    const createdAt = this.dependencies.clock.now();
    const caseId = this.dependencies.identifiers.nextCaseId();
    const jobId = this.dependencies.identifiers.nextJobId();
    const queued: StoredReproduction = {
      callerId: command.callerId,
      case: createCase(caseId, createdAt),
      commandHash,
      idempotencyKey: command.idempotencyKey,
      job: createJob(jobId, caseId, createdAt),
      result: null,
      sampleId: command.sampleId,
    };
    const reservation = await this.dependencies.repository.reserve(queued);
    if (!reservation.created) {
      if (reservation.record.commandHash !== commandHash) {
        throw new IdempotencyConflictError();
      }
      return startResultSchema.parse({
        reused: true,
        snapshot: toSnapshot(reservation.record),
      });
    }

    const running: StoredReproduction = {
      ...queued,
      job: transitionJob(queued.job, "RUNNING", {
        at: this.dependencies.clock.now(),
        progressPhase: "INGESTING",
      }),
    };
    await this.dependencies.repository.save(running);

    try {
      const result = await this.executeTrustedSample({
        budget: command.budget,
        caseId,
        startedAt: createdAt,
      });
      const succeeded: StoredReproduction = {
        ...running,
        case: result.case,
        job: transitionJob(running.job, "SUCCEEDED", {
          at: this.dependencies.clock.now(),
          progressPhase: result.case.state,
        }),
        result,
      };
      await this.dependencies.repository.save(succeeded);
      return startResultSchema.parse({
        reused: false,
        snapshot: toSnapshot(succeeded),
      });
    } catch {
      const failed: StoredReproduction = {
        ...running,
        job: transitionJob(running.job, "FAILED", {
          at: this.dependencies.clock.now(),
          failure: {
            code: "TRUSTED_EXECUTION_FAILED",
            message: "The trusted reproduction failed safely",
            retryable: true,
          },
          progressPhase: running.case.state,
        }),
      };
      await this.dependencies.repository.save(failed);
      throw new TrustedExecutionFailedError();
    }
  }

  async getReproduction(rawQuery: GetReproduction): Promise<ReproductionSnapshot> {
    const query = getReproductionSchema.parse(rawQuery);
    const record = await this.dependencies.repository.findByCaseId(
      query.callerId,
      query.caseId,
    );
    if (!record) throw new ReproductionNotFoundError();
    return toSnapshot(record);
  }

  async getJob(rawQuery: GetJob): Promise<JobSnapshot> {
    const query = getJobSchema.parse(rawQuery);
    const record = await this.dependencies.repository.findByJobId(
      query.callerId,
      query.jobId,
    );
    if (!record) throw new ReproductionNotFoundError();
    return jobSnapshotSchema.parse({ job: record.job, schemaVersion: "2.0" });
  }

  async exportReproBundle(rawQuery: GetReproduction): Promise<ExportResult> {
    const snapshot = await this.getReproduction(rawQuery);
    if (!snapshot.result || snapshot.result.summary.status !== "VERIFIED") {
      throw new BundleNotReadyError();
    }
    return exportResultSchema.parse({
      bundle: snapshot.result.bundle,
      caseId: snapshot.case.id,
      files: snapshot.result.files,
      schemaVersion: "2.0",
    });
  }
}

