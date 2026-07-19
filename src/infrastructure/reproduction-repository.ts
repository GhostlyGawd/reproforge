import type { SampleCaseResult } from "@/application/sample-case";
import type { ReproCase } from "@/domain/case";
import type { ReproductionJob } from "@/domain/job";

export type StoredReproduction = {
  callerId: string;
  case: ReproCase;
  commandHash: string;
  idempotencyKey: string;
  job: ReproductionJob;
  result: SampleCaseResult | null;
  sampleId: "cli-spaces";
};

export type ReservationResult =
  | { created: true; record: StoredReproduction }
  | { created: false; record: StoredReproduction };

export interface ReproductionRepository {
  findByCaseId(callerId: string, caseId: string): Promise<StoredReproduction | null>;
  findByIdempotencyKey(
    callerId: string,
    idempotencyKey: string,
  ): Promise<StoredReproduction | null>;
  findByJobId(callerId: string, jobId: string): Promise<StoredReproduction | null>;
  reserve(record: StoredReproduction): Promise<ReservationResult>;
  save(record: StoredReproduction): Promise<void>;
}

function clone(record: StoredReproduction): StoredReproduction {
  return structuredClone(record);
}

function scoped(callerId: string, value: string): string {
  return JSON.stringify([callerId, value]);
}

export class InMemoryReproductionRepository implements ReproductionRepository {
  private readonly byCase = new Map<string, StoredReproduction>();
  private readonly byIdempotency = new Map<string, StoredReproduction>();
  private readonly byJob = new Map<string, StoredReproduction>();

  async findByCaseId(
    callerId: string,
    caseId: string,
  ): Promise<StoredReproduction | null> {
    const record = this.byCase.get(scoped(callerId, caseId));
    return record ? clone(record) : null;
  }

  async findByIdempotencyKey(
    callerId: string,
    idempotencyKey: string,
  ): Promise<StoredReproduction | null> {
    const record = this.byIdempotency.get(scoped(callerId, idempotencyKey));
    return record ? clone(record) : null;
  }

  async findByJobId(
    callerId: string,
    jobId: string,
  ): Promise<StoredReproduction | null> {
    const record = this.byJob.get(scoped(callerId, jobId));
    return record ? clone(record) : null;
  }

  async reserve(record: StoredReproduction): Promise<ReservationResult> {
    const key = scoped(record.callerId, record.idempotencyKey);
    const existing = this.byIdempotency.get(key);
    if (existing) {
      return { created: false, record: clone(existing) };
    }
    this.write(record);
    return { created: true, record: clone(record) };
  }

  async save(record: StoredReproduction): Promise<void> {
    this.write(record);
  }

  private write(record: StoredReproduction): void {
    const saved = clone(record);
    this.byCase.set(scoped(saved.callerId, saved.case.id), saved);
    this.byIdempotency.set(
      scoped(saved.callerId, saved.idempotencyKey),
      saved,
    );
    this.byJob.set(scoped(saved.callerId, saved.job.id), saved);
  }
}

