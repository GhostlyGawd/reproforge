import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { createCase } from "@/domain/case";
import type { FailureOracle } from "@/domain/oracle";
import type {
  IsolatedSandboxProvider,
  IsolatedSandboxSession,
  SandboxCommandResult,
} from "@/execution/contracts";
import { buildNodeExecutionPlan } from "@/execution/execution-planning";
import { IsolatedRepositoryRunner } from "@/execution/isolated-repository-runner";

const source = {
  commitSha: "a".repeat(40),
  fullName: "acme/repository",
  private: true,
  provider: "github" as const,
  repositoryId: "repo_42",
};
const profile = {
  controlScript: "test:control",
  ecosystem: "node" as const,
  lockfile: "package-lock.json" as const,
  nodeVersion: "24" as const,
  packageManager: "npm" as const,
  reproductionScript: "test:repro",
};
const oracle: FailureOracle = {
  id: "oracle-repository",
  root: { expected: 1, type: "exit_code" },
  version: 1,
};

describe("isolated repository runner", () => {
  it("joins preparation to one fresh snapshot-restored VM per machine run", async () => {
    const fixture = harness();
    const runner = new IsolatedRepositoryRunner(fixture.dependencies);

    const result = await runner.execute({
      attemptId: "attempt_repository_42",
      budget: { maxToolCalls: 6, requiredRuns: 3 },
      case: createCase(
        "case_repository_42",
        new Date("2026-07-19T16:00:00.000Z"),
      ),
      issueEvidence: { number: 42, title: "Synthetic repository failure" },
      oracle,
      principal: {
        callerId: "principal_42",
        principalId: "principal_42",
        tenantId: "tenant_42",
      },
      profile,
      source,
    });

    expect(result.summary.status).toBe("VERIFIED");
    expect(result.provenance.cleanupStatus).toBe("clean");
    expect(fixture.events).toEqual([
      "create-prepared",
      "acquire",
      "dependencies",
      "workspaces",
      "environment",
      "snapshot",
      "restore-1",
      "run-control-1-restored-1",
      "stop-restored-1",
      "restore-2",
      "run-candidate-1-restored-2",
      "stop-restored-2",
      "restore-3",
      "run-candidate-2-restored-3",
      "stop-restored-3",
      "restore-4",
      "run-candidate-3-restored-4",
      "stop-restored-4",
      "delete-snapshot",
    ]);
    expect(new Set(fixture.runSessions).size).toBe(4);
    expect(fixture.prepared.stop).toHaveBeenCalledTimes(1);
    expect(fixture.snapshotDelete).toHaveBeenCalledTimes(1);
  });

  it("stops and quarantines a prepared VM when pre-snapshot preparation fails", async () => {
    const fixture = harness();
    fixture.dependencies.prepareDependencies.mockRejectedValueOnce(
      new Error("synthetic dependency provider detail"),
    );
    fixture.prepared.stop.mockRejectedValueOnce(
      new Error("synthetic cleanup provider detail"),
    );
    const runner = new IsolatedRepositoryRunner(fixture.dependencies);

    await expect(
      runner.execute({
        attemptId: "attempt_repository_failure",
        budget: { maxToolCalls: 6, requiredRuns: 3 },
        case: createCase("case_repository_failure"),
        oracle,
        principal: {
          callerId: "principal_42",
          principalId: "principal_42",
          tenantId: "tenant_42",
        },
        profile,
        source,
      }),
    ).rejects.toMatchObject({ code: "EXECUTION_FAILED" });
    expect(fixture.quarantine).toHaveBeenCalledWith({
      attemptId: "attempt_repository_failure",
      providerResourceId: "prepared",
      reason: "cleanup-failed",
      resourceType: "sandbox",
    });
  });
});

function harness() {
  const events: string[] = [];
  const snapshotDelete = vi.fn(async () => {
    events.push("delete-snapshot");
  });
  const prepared = session("prepared", events);
  prepared.snapshot = vi.fn(async () => {
    events.push("snapshot");
    return { delete: snapshotDelete, snapshotId: "snapshot_42" };
  });
  let restoredIndex = 0;
  const provider: IsolatedSandboxProvider = {
    create: vi.fn(async () => {
      events.push("create-prepared");
      return prepared;
    }),
    createFromSnapshot: vi.fn(async () => {
      restoredIndex += 1;
      events.push(`restore-${restoredIndex}`);
      return session(`restored-${restoredIndex}`, events);
    }),
  };
  const plan = buildNodeExecutionPlan({ profile, requiredRuns: 3, source });
  const runSessions: string[] = [];
  const quarantine = vi.fn(async () => undefined);
  const dependencies = {
    acquire: vi.fn(async () => {
      events.push("acquire");
      return {
        manifest: {
          archiveBytes: 4_096,
          archiveSha256: "b".repeat(64),
          extractedBytes: 8_192,
          fileCount: 8,
          files: [{ path: "package.json", size: 128 }],
          rootDirectory: "acme-repository-a",
        },
        provenance: {
          acquiredAt: "2026-07-19T16:00:01.000Z",
          archiveBytes: 4_096,
          archiveSha256: "b".repeat(64),
          commitSha: source.commitSha,
          extractedBytes: 8_192,
          fileCount: 8,
          manifestSha256: "c".repeat(64),
          policyVersion: "source-archive-v1" as const,
          provider: "github" as const,
          repositoryId: source.repositoryId,
          schemaVersion: "1.0" as const,
        },
        workspacePath: "/vercel/sandbox/workspaces/source",
      };
    }),
    clock: { now: () => new Date("2026-07-19T16:00:20.000Z") },
    collectEnvironment: vi.fn(async () => {
      events.push("environment");
      return {
        archiveSha256: "b".repeat(64),
        dependencyPolicyVersion: "node-lock-v1" as const,
        environmentHash: "f".repeat(64),
        executionPolicyVersion: "node-npm-v1" as const,
        lockfileSha256: "d".repeat(64),
        manifestSha256: "c".repeat(64),
        networkPolicy: "deny-all" as const,
        nodeVersion: "24.8.0",
        npmVersion: "11.4.2",
        packageJsonSha256: "e".repeat(64),
        provider: "vercel-sandbox" as const,
        runtime: "node24" as const,
        schemaVersion: "1.0" as const,
        sourceCommitSha: source.commitSha,
        sourcePolicyVersion: "source-archive-v1" as const,
        vcpus: 2 as const,
      };
    }),
    executeRun: vi.fn(async ({ command, runId, session: restored }) => {
      events.push(`run-${runId}-${restored.sandboxId}`);
      runSessions.push(restored.sandboxId);
      const candidate = command.phase === "candidate";
      const stderr = candidate ? "synthetic failure" : "";
      return {
        capture: {
          stderr: capture(stderr),
          stdout: capture(""),
        },
        role: candidate ? ("candidate" as const) : ("control" as const),
        run: {
          command: `${command.executable} ${command.args.join(" ")}`,
          durationMs: 10,
          environmentHash: "f".repeat(64),
          exitCode: candidate ? 1 : 0,
          id: runId,
          stderr,
          stdout: "",
        },
      };
    }),
    plan: () => plan,
    prepareDependencies: vi.fn(async () => {
      events.push("dependencies");
      return {
        dependencyCount: 12,
        installWorkspace: "/vercel/sandbox/workspaces/source",
        lockfileSha256: "d".repeat(64),
        lockfileVersion: 3 as const,
        networkPolicy: "deny-all" as const,
        packageJsonSha256: "e".repeat(64),
        policyVersion: "node-lock-v1" as const,
      };
    }),
    prepareWorkspaces: vi.fn(async () => {
      events.push("workspaces");
      return {
        candidateWorkspaces: [
          "/vercel/sandbox/workspaces/candidate-1",
          "/vercel/sandbox/workspaces/candidate-2",
          "/vercel/sandbox/workspaces/candidate-3",
        ],
        controlWorkspace: "/vercel/sandbox/workspaces/control",
      };
    }),
    provider,
    quarantine: { record: quarantine },
  };
  return {
    dependencies,
    events,
    prepared,
    quarantine,
    runSessions,
    snapshotDelete,
  };
}

function session(
  sandboxId: string,
  events: string[],
): IsolatedSandboxSession & { stop: ReturnType<typeof vi.fn> } {
  const result: SandboxCommandResult = {
    durationMs: 0,
    exitCode: 0,
    stderr: new Uint8Array(),
    stdout: new Uint8Array(),
  };
  return {
    makeDirectory: async () => undefined,
    readFile: async () => null,
    run: async () => result,
    sandboxId,
    setNetworkPolicy: async () => undefined,
    snapshot: async () => ({
      delete: async () => undefined,
      snapshotId: "snapshot-default",
    }),
    stop: vi.fn(async () => {
      if (sandboxId !== "prepared") events.push(`stop-${sandboxId}`);
    }),
    usage: async () => ({
      activeCpuMs: 0,
      networkEgressBytes: 0,
      networkIngressBytes: 0,
    }),
    writeFiles: async () => undefined,
  } as IsolatedSandboxSession & { stop: ReturnType<typeof vi.fn> };
}

function capture(text: string) {
  const bytes = new TextEncoder().encode(text);
  return {
    originalBytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    text,
    truncated: false,
  };
}
