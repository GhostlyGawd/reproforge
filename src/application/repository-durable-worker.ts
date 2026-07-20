import { createHash } from "node:crypto";

import type { DurableWorker } from "@/application/durable-queue-consumer";
import {
  artifactDescriptorSchema,
  type ArtifactDescriptor,
  type ArtifactStore,
} from "@/application/ports/production";
import { canonicalJson } from "@/domain/bundle";
import { transitionJob } from "@/domain/job";
import {
  repositoryProofResultSchema,
  type RepositoryProofResult,
} from "@/execution/repository-proof";

type Clock = Readonly<{ now(): Date }>;

type Dependencies = Readonly<{
  artifactStore: ArtifactStore;
  clock: Clock;
  execute: DurableWorker["execute"] extends (
    input: infer Input,
  ) => Promise<unknown>
    ? (input: Input) => Promise<RepositoryProofResult>
    : never;
  retentionDays: number;
}>;

export class RepositoryDurableWorkerError extends Error {
  constructor(
    readonly code:
      | "ARTIFACT_PERSISTENCE_FAILED"
      | "INVALID_REPOSITORY_PROOF",
  ) {
    super("The repository worker could not commit a trusted terminal result");
    this.name = "RepositoryDurableWorkerError";
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function artifactId(tenantId: string, caseId: string, digest: string): string {
  return `artifact_${createHash("sha256")
    .update([tenantId, caseId, digest].join("\u0000"))
    .digest("hex")
    .slice(0, 48)}`;
}

export function repositoryBundleBytes(
  result: RepositoryProofResult,
): Uint8Array {
  if (!result.bundle) throw new RepositoryDurableWorkerError("INVALID_REPOSITORY_PROOF");
  return new TextEncoder().encode(
    canonicalJson({
      bundle: result.bundle,
      files: result.files,
      schemaVersion: "1.0",
    }),
  );
}

export function repositoryBundleDescriptor(input: {
  bytes: Uint8Array;
  caseId: string;
  createdAt: string;
  retentionDays: number;
  tenantId: string;
}): ArtifactDescriptor {
  const digest = sha256(input.bytes);
  return artifactDescriptorSchema.parse({
    artifactId: artifactId(input.tenantId, input.caseId, digest),
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
  });
}

function sameDescriptor(
  expected: ArtifactDescriptor,
  actual: ArtifactDescriptor,
): boolean {
  return canonicalJson(expected) === canonicalJson(actual);
}

export class RepositoryDurableWorker implements DurableWorker {
  constructor(private readonly dependencies: Dependencies) {
    if (
      !Number.isInteger(dependencies.retentionDays) ||
      dependencies.retentionDays < 1 ||
      dependencies.retentionDays > 365
    ) {
      throw new RepositoryDurableWorkerError("INVALID_REPOSITORY_PROOF");
    }
  }

  async execute(
    input: Parameters<DurableWorker["execute"]>[0],
  ): Promise<Awaited<ReturnType<DurableWorker["execute"]>>> {
    const { lease, message, record } = input;
    const source = record.snapshot.repositorySource;
    if (
      !source ||
      record.snapshot.sampleId !== undefined ||
      record.snapshot.job.state !== "RUNNING" ||
      record.snapshot.job.attempt !== lease.attempt ||
      record.jobId !== lease.jobId ||
      record.tenantId !== lease.tenantId ||
      record.caseId !== message.caseId ||
      record.jobId !== message.jobId ||
      record.tenantId !== message.tenantId
    ) {
      throw new RepositoryDurableWorkerError("INVALID_REPOSITORY_PROOF");
    }

    let result: RepositoryProofResult;
    try {
      result = repositoryProofResultSchema.parse(
        await this.dependencies.execute(input),
      );
    } catch {
      throw new RepositoryDurableWorkerError("INVALID_REPOSITORY_PROOF");
    }
    if (
      result.case.id !== record.caseId ||
      result.provenance.source.commitSha !== source.commitSha ||
      result.provenance.source.repositoryId !== source.repositoryId
    ) {
      throw new RepositoryDurableWorkerError("INVALID_REPOSITORY_PROOF");
    }

    if (result.bundle) {
      const bytes = repositoryBundleBytes(result);
      const descriptor = repositoryBundleDescriptor({
        bytes,
        caseId: record.caseId,
        createdAt: record.createdAt,
        retentionDays: this.dependencies.retentionDays,
        tenantId: record.tenantId,
      });
      try {
        const stored = artifactDescriptorSchema.parse(
          await this.dependencies.artifactStore.put({ bytes, descriptor }),
        );
        if (!sameDescriptor(descriptor, stored)) {
          throw new RepositoryDurableWorkerError(
            "ARTIFACT_PERSISTENCE_FAILED",
          );
        }
      } catch {
        throw new RepositoryDurableWorkerError("ARTIFACT_PERSISTENCE_FAILED");
      }
    }

    const completedAt = new Date(
      Math.max(
        this.dependencies.clock.now().getTime(),
        Date.parse(result.case.updatedAt),
        Date.parse(record.snapshot.job.updatedAt),
      ),
    );
    return {
      ...record,
      snapshot: {
        ...record.snapshot,
        case: result.case,
        job: transitionJob(record.snapshot.job, "SUCCEEDED", {
          at: completedAt,
          progressPhase: result.case.state,
        }),
        result,
      },
      updatedAt: completedAt.toISOString(),
    };
  }
}
