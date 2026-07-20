import { describe, expect, it, vi } from "vitest";

import type {
  ArtifactStore,
  DurableReproductionRecord,
} from "@/application/ports/production";
import { RepositoryDurableWorker } from "@/application/repository-durable-worker";
import { runTrustedSample } from "@/application/sample-case";
import { createCase } from "@/domain/case";
import { createJob, transitionJob } from "@/domain/job";
import { repositoryProofResultSchema } from "@/execution/repository-proof";

describe("repository durable worker", () => {
  it("uploads and verifies the bundle artifact before returning terminal success", async () => {
    const fixture = await harness();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    fixture.put.mockImplementation(async ({ descriptor }) => {
      await pending;
      return descriptor;
    });
    let settled = false;

    const execution = fixture.worker
      .execute({
        lease: fixture.lease,
        message: fixture.message,
        record: fixture.record,
      })
      .finally(() => {
        settled = true;
      });
    await vi.waitFor(() => expect(fixture.put).toHaveBeenCalledTimes(1));
    expect(settled).toBe(false);
    release();
    const completed = await execution;

    expect(completed.snapshot.job.state).toBe("SUCCEEDED");
    expect(completed.snapshot.case.state).toBe("VERIFIED");
    expect(completed.snapshot.result).toEqual(fixture.proof);
    expect(fixture.put).toHaveBeenCalledWith({
      bytes: expect.any(Uint8Array),
      descriptor: expect.objectContaining({
        caseId: fixture.record.caseId,
        kind: "bundle",
        tenantId: fixture.record.tenantId,
      }),
    });
  });

  it("never returns terminal success when private artifact persistence fails", async () => {
    const fixture = await harness();
    fixture.put.mockRejectedValue(new Error("synthetic provider detail"));

    await expect(
      fixture.worker.execute({
        lease: fixture.lease,
        message: fixture.message,
        record: fixture.record,
      }),
    ).rejects.toThrow();
  });

  it("fails closed when proof source does not match the durable request", async () => {
    const fixture = await harness();
    const mismatched = repositoryProofResultSchema.parse({
      ...fixture.proof,
      provenance: {
        ...fixture.proof.provenance,
        source: {
          ...fixture.proof.provenance.source,
          commitSha: "9".repeat(40),
        },
      },
    });
    const worker = new RepositoryDurableWorker({
      artifactStore: fixture.artifactStore,
      clock: { now: () => new Date("2026-07-19T16:01:00.000Z") },
      execute: async () => mismatched,
      retentionDays: 30,
    });

    await expect(
      worker.execute({
        lease: fixture.lease,
        message: fixture.message,
        record: fixture.record,
      }),
    ).rejects.toMatchObject({ code: "INVALID_REPOSITORY_PROOF" });
    expect(fixture.put).not.toHaveBeenCalled();
  });
});

async function harness() {
  const at = new Date("2026-07-19T16:00:00.000Z");
  const source = {
    commitSha: "a".repeat(40),
    fullName: "acme/repository",
    private: true,
    provider: "github" as const,
    repositoryId: "repo_42",
  };
  const caseId = "case_repository_durable";
  const jobId = "job_repository_durable";
  const runningJob = transitionJob(createJob(jobId, caseId, at), "RUNNING", {
    at,
    progressPhase: "INGESTING",
  });
  const record: DurableReproductionRecord = {
    callerId: "principal_42",
    caseId,
    commandHash: "7".repeat(64),
    createdAt: at.toISOString(),
    idempotencyKey: "repository-start-42",
    jobId,
    requestedBudget: { maxToolCalls: 6, requiredRuns: 3 },
    snapshot: {
      case: createCase(caseId, at),
      job: runningJob,
      repositorySource: source,
      result: null,
      schemaVersion: "2.0",
    },
    tenantId: "tenant_42",
    updatedAt: at.toISOString(),
    version: 1,
  };
  const sample = await runTrustedSample({ caseId, startedAt: at });
  const proof = repositoryProofResultSchema.parse({
    ...sample,
    kind: "repository",
    provenance: {
      cleanupStatus: "clean",
      dependency: {
        dependencyCount: 12,
        lockfileSha256: "d".repeat(64),
        lockfileVersion: 3,
        packageJsonSha256: "e".repeat(64),
        policyVersion: "node-lock-v1",
      },
      environment: {
        archiveSha256: "b".repeat(64),
        dependencyPolicyVersion: "node-lock-v1",
        environmentHash: "f".repeat(64),
        executionPolicyVersion: "node-npm-v1",
        lockfileSha256: "d".repeat(64),
        manifestSha256: "c".repeat(64),
        networkPolicy: "deny-all",
        nodeVersion: "24.8.0",
        npmVersion: "11.4.2",
        packageJsonSha256: "e".repeat(64),
        provider: "vercel-sandbox",
        runtime: "node24",
        schemaVersion: "1.0",
        sourceCommitSha: source.commitSha,
        sourcePolicyVersion: "source-archive-v1",
        vcpus: 2,
      },
      limitsPolicyVersion: "sandbox-limits-v1",
      source: {
        acquiredAt: at.toISOString(),
        archiveBytes: 4_096,
        archiveSha256: "b".repeat(64),
        commitSha: source.commitSha,
        extractedBytes: 8_192,
        fileCount: 8,
        manifestSha256: "c".repeat(64),
        policyVersion: "source-archive-v1",
        provider: "github",
        repositoryId: source.repositoryId,
        schemaVersion: "1.0",
      },
    },
  });
  const put = vi.fn<ArtifactStore["put"]>(async ({ descriptor }) => descriptor);
  const artifactStore: ArtifactStore = {
    delete: async () => false,
    put,
    read: async () => null,
  };
  const worker = new RepositoryDurableWorker({
    artifactStore,
    clock: { now: () => new Date("2026-07-19T16:01:00.000Z") },
    execute: async () => proof,
    retentionDays: 30,
  });
  const lease = {
    acquiredAt: at.toISOString(),
    attempt: 1,
    expiresAt: new Date(at.getTime() + 90_000).toISOString(),
    jobId,
    ownerId: "worker_42",
    tenantId: record.tenantId,
  };
  const message = {
    caseId,
    eventId: "outbox_case_repository_durable",
    jobId,
    kind: "reproduction.requested" as const,
    schemaVersion: "1.0" as const,
    tenantId: record.tenantId,
  };
  return {
    artifactStore,
    lease,
    message,
    proof,
    put,
    record,
    worker,
  };
}
