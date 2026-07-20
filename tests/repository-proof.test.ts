import { describe, expect, it } from "vitest";

import { createCase } from "@/domain/case";
import { validateMaterializedBundle } from "@/domain/bundle";
import type { FailureOracle } from "@/domain/oracle";
import type { BoundedExperimentResult } from "@/execution/bounded-execution";
import type { NodeRepositoryProfile } from "@/execution/contracts";
import type { DependencyMetadata } from "@/execution/dependency-preparation";
import type { ExecutionEnvironmentProvenance } from "@/execution/execution-planning";
import {
  assembleRepositoryProof,
  RepositoryProofInputError,
} from "@/execution/repository-proof";
import type { SourceProvenance } from "@/execution/source-provenance";

const profile: NodeRepositoryProfile = {
  controlScript: "test:control",
  ecosystem: "node",
  lockfile: "package-lock.json",
  nodeVersion: "24",
  packageManager: "npm",
  reproductionScript: "test:repro",
};

const oracle: FailureOracle = {
  id: "oracle-repository-exit",
  root: {
    children: [
      { expected: 1, type: "exit_code" },
      { stream: "stderr", type: "output_contains", value: "synthetic failure" },
    ],
    type: "all",
  },
  version: 1,
};

const source = {
  commitSha: "a".repeat(40),
  fullName: "acme/repository",
  private: true,
  provider: "github" as const,
  repositoryId: "repo_42",
};

const sourceProvenance: SourceProvenance = {
  acquiredAt: "2026-07-19T16:00:00.000Z",
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
};

const dependency: DependencyMetadata = {
  dependencyCount: 12,
  lockfileSha256: "d".repeat(64),
  lockfileVersion: 3,
  packageJsonSha256: "e".repeat(64),
  policyVersion: "node-lock-v1",
};

const environment: ExecutionEnvironmentProvenance = {
  archiveSha256: sourceProvenance.archiveSha256,
  dependencyPolicyVersion: "node-lock-v1",
  environmentHash: "f".repeat(64),
  executionPolicyVersion: "node-npm-v1",
  lockfileSha256: dependency.lockfileSha256,
  manifestSha256: sourceProvenance.manifestSha256,
  networkPolicy: "deny-all",
  nodeVersion: "24.8.0",
  npmVersion: "11.4.2",
  packageJsonSha256: dependency.packageJsonSha256,
  provider: "vercel-sandbox",
  runtime: "node24",
  schemaVersion: "1.0",
  sourceCommitSha: source.commitSha,
  sourcePolicyVersion: "source-archive-v1",
  vcpus: 2,
};

describe("repository proof assembly", () => {
  it("derives VERIFIED from the oracle and emits one valid content-addressed bundle", async () => {
    const result = await assembleRepositoryProof(fixture());

    expect(result.summary).toMatchObject({
      candidateMatches: 3,
      controlMatched: false,
      status: "VERIFIED",
    });
    expect(result.case.state).toBe("VERIFIED");
    expect(result.minimization).toMatchObject({
      acceptedReductionId: null,
      claim: "baseline-retained",
    });
    expect(result.bundle?.lock).toMatchObject({
      dependencyLockHash: dependency.lockfileSha256,
      environmentHash: environment.environmentHash,
      repository: source.fullName,
      revision: source.commitSha,
    });
    expect(validateMaterializedBundle(result.files)).toEqual({
      errors: [],
      success: true,
    });
  });

  it("ignores no provider claim because unknown proof fields fail closed", async () => {
    await expect(
      assembleRepositoryProof({
        ...fixture(),
        providerClaimedStatus: "VERIFIED",
      } as never),
    ).rejects.toBeInstanceOf(RepositoryProofInputError);
  });

  it("returns UNSTABLE without minimization, files, or a bundle", async () => {
    const input = fixture();
    input.execution.candidates[2] = boundedRun("candidate-3", 0, "");

    const result = await assembleRepositoryProof(input);

    expect(result.summary.status).toBe("UNSTABLE");
    expect(result.case.state).toBe("UNSTABLE");
    expect(result.bundle).toBeNull();
    expect(result.minimization).toBeNull();
    expect(result.files).toEqual({});
  });

  it("redacts acquisition secrets from every persisted proof surface", async () => {
    const secret = "synthetic-github-secret-value";
    const input = fixture();
    input.execution.candidates[0] = boundedRun(
      "candidate-1",
      1,
      `synthetic failure ${secret}`,
    );
    input.secrets = [secret];

    const result = await assembleRepositoryProof(input);
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain(secret);
    expect(serialized).toContain("[REDACTED]");
  });
});

function fixture() {
  return {
    budget: { maxToolCalls: 6, requiredRuns: 3 },
    case: createCase("case_repository", new Date("2026-07-19T16:00:00.000Z")),
    cleanupStatus: "clean" as const,
    dependency,
    environment,
    execution: {
      candidates: [
        boundedRun("candidate-1", 1, "synthetic failure"),
        boundedRun("candidate-2", 1, "synthetic failure"),
        boundedRun("candidate-3", 1, "synthetic failure"),
      ],
      control: boundedRun("control-1", 0, ""),
      limitsPolicyVersion: "sandbox-limits-v1" as const,
      totalDurationMs: 40,
    } satisfies BoundedExperimentResult,
    generatedAt: "2026-07-19T16:00:20.000Z",
    issueEvidence: { number: 42, title: "A synthetic failure is reproducible" },
    oracle,
    profile,
    secrets: [] as string[],
    source,
    sourceProvenance,
  };
}

function boundedRun(id: string, exitCode: number, stderr: string) {
  const bytes = new TextEncoder().encode(stderr);
  return {
    capture: {
      stderr: {
        originalBytes: bytes.byteLength,
        sha256: "1".repeat(64),
        text: stderr,
        truncated: false,
      },
      stdout: {
        originalBytes: 0,
        sha256: "2".repeat(64),
        text: "",
        truncated: false,
      },
    },
    role: id.startsWith("control") ? ("control" as const) : ("candidate" as const),
    run: {
      command: id.startsWith("control")
        ? 'npm "run" "test:control"'
        : 'npm "run" "test:repro"',
      durationMs: 10,
      environmentHash: environment.environmentHash,
      exitCode,
      id,
      stderr,
      stdout: "",
    },
  };
}
