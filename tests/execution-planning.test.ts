import { describe, expect, it } from "vitest";

import type {
  ImmutableRepositorySource,
  IsolatedSandboxSession,
  NodeRepositoryProfile,
  SandboxCommand,
  SandboxCommandResult,
} from "@/execution/contracts";
import type { DependencyMetadata } from "@/execution/dependency-preparation";
import {
  buildNodeExecutionPlan,
  collectExecutionEnvironment,
  prepareExperimentWorkspaces,
  WorkspacePreparationError,
} from "@/execution/execution-planning";
import type { SourceProvenance } from "@/execution/source-provenance";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const source: ImmutableRepositorySource = {
  commitSha: SHA,
  fullName: "GhostlyGawd/reproforge",
  private: false,
  provider: "github",
  repositoryId: "repo_opaque_1",
};
const profile: NodeRepositoryProfile = {
  controlScript: "test:control",
  ecosystem: "node",
  lockfile: "package-lock.json",
  nodeVersion: "24",
  packageManager: "npm",
  reproductionScript: "test:reproduce",
  testNamePattern: "path with spaces; remains one arg",
  workspace: "packages/cli",
};
const dependency: DependencyMetadata = {
  dependencyCount: 5,
  lockfileSha256: "b".repeat(64),
  lockfileVersion: 3,
  packageJsonSha256: "c".repeat(64),
  policyVersion: "node-lock-v1",
};
const provenance: SourceProvenance = {
  acquiredAt: "2026-07-20T00:00:00.000Z",
  archiveBytes: 1024,
  archiveSha256: "a".repeat(64),
  commitSha: SHA,
  extractedBytes: 2048,
  fileCount: 10,
  manifestSha256: "d".repeat(64),
  policyVersion: "source-archive-v1",
  provider: "github",
  repositoryId: "repo_opaque_1",
  schemaVersion: "1.0",
};

describe("typed execution planning", () => {
  it("derives exact npm commands and keeps repository text out of executable selection", () => {
    const plan = buildNodeExecutionPlan({
      profile,
      requiredRuns: 3,
      source,
    });

    expect(plan.commands.map((command) => command.phase)).toEqual([
      "dependency-acquisition",
      "offline-install",
      "control",
      "candidate",
      "candidate",
      "candidate",
    ]);
    const control = plan.commands.find((command) => command.phase === "control");
    const candidates = plan.commands.filter(
      (command) => command.phase === "candidate",
    );
    expect(control).toEqual({
      args: [
        "run",
        "test:control",
        "--",
        "--testNamePattern",
        "path with spaces; remains one arg",
      ],
      cwd: "/vercel/sandbox/workspaces/control/packages/cli",
      executable: "npm",
      phase: "control",
      timeoutMs: 120_000,
    });
    expect(candidates.map((command) => command.cwd)).toEqual([
      "/vercel/sandbox/workspaces/candidate-1/packages/cli",
      "/vercel/sandbox/workspaces/candidate-2/packages/cli",
      "/vercel/sandbox/workspaces/candidate-3/packages/cli",
    ]);
    expect(new Set(plan.commands.map((command) => command.executable))).toEqual(
      new Set(["npm"]),
    );
  });

  it("creates a clean independent workspace for every experiment", async () => {
    const fixture = harness();
    const plan = buildNodeExecutionPlan({ profile, requiredRuns: 3, source });
    const result = await prepareExperimentWorkspaces({
      networkPolicy: "deny-all",
      plan,
      session: fixture.session,
      sourceWorkspace: "/vercel/sandbox/workspaces/source",
    });

    expect(result).toEqual({
      candidateWorkspaces: [
        "/vercel/sandbox/workspaces/candidate-1",
        "/vercel/sandbox/workspaces/candidate-2",
        "/vercel/sandbox/workspaces/candidate-3",
      ],
      controlWorkspace: "/vercel/sandbox/workspaces/control",
    });
    expect(fixture.directories).toEqual([
      "/vercel/sandbox/workspaces/control",
      "/vercel/sandbox/workspaces/candidate-1",
      "/vercel/sandbox/workspaces/candidate-2",
      "/vercel/sandbox/workspaces/candidate-3",
    ]);
    expect(fixture.commands).toHaveLength(4);
    expect(fixture.commands.every((command) => command.executable === "cp")).toBe(
      true,
    );
    expect(
      fixture.commands.every((command) =>
        command.args.includes("--reflink=auto"),
      ),
    ).toBe(true);
  });

  it("binds sanitized immutable inputs and actual tool versions into one stable hash", async () => {
    const first = harness();
    const second = harness();
    const input = {
      dependency,
      networkPolicy: "deny-all" as const,
      profile,
      source: provenance,
    };

    const one = await collectExecutionEnvironment({ ...input, session: first.session });
    const two = await collectExecutionEnvironment({ ...input, session: second.session });

    expect(one).toEqual(two);
    expect(one).toMatchObject({
      dependencyPolicyVersion: "node-lock-v1",
      executionPolicyVersion: "node-npm-v1",
      networkPolicy: "deny-all",
      nodeVersion: "24.4.1",
      npmVersion: "11.4.2",
      provider: "vercel-sandbox",
      runtime: "node24",
      sourceCommitSha: SHA,
      sourcePolicyVersion: "source-archive-v1",
      vcpus: 2,
    });
    expect(one.environmentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(one)).not.toContain(source.fullName);
    expect(JSON.stringify(one)).not.toContain("private");

    const changed = await collectExecutionEnvironment({
      ...input,
      dependency: { ...dependency, lockfileSha256: "e".repeat(64) },
      session: harness().session,
    });
    expect(changed.environmentHash).not.toBe(one.environmentHash);
  });

  it("fails closed when a clean workspace copy cannot be created", async () => {
    const fixture = harness({ copyFailure: true });
    const plan = buildNodeExecutionPlan({ profile, requiredRuns: 3, source });
    await expect(
      prepareExperimentWorkspaces({
        networkPolicy: "deny-all",
        plan,
        session: fixture.session,
        sourceWorkspace: "/vercel/sandbox/workspaces/source",
      }),
    ).rejects.toBeInstanceOf(WorkspacePreparationError);
    expect(fixture.commands).toHaveLength(1);
  });
});

function harness(options: { copyFailure?: boolean } = {}) {
  const directories: string[] = [];
  const commands: SandboxCommand[] = [];
  const encode = (value: string) => new TextEncoder().encode(value);
  const result = (
    stdout = "",
    exitCode = 0,
  ): SandboxCommandResult => ({
    durationMs: 4,
    exitCode,
    stderr: new Uint8Array(),
    stdout: encode(stdout),
  });
  const session: IsolatedSandboxSession = {
    makeDirectory: async (path) => {
      directories.push(path);
    },
    readFile: async () => null,
    run: async (command) => {
      commands.push(command);
      if (command.executable === "cp") {
        return result("", options.copyFailure ? 1 : 0);
      }
      if (command.executable === "node" && command.args.includes("--version")) {
        return result("v24.4.1\n");
      }
      if (command.executable === "npm" && command.args.includes("--version")) {
        return result("11.4.2\n");
      }
      throw new Error("unexpected command");
    },
    sandboxId: "sandbox_1",
    setNetworkPolicy: async () => undefined,
    snapshot: async () => ({
      delete: async () => undefined,
      snapshotId: "snap_test",
    }),
    stop: async () => undefined,
    usage: async () => ({
      activeCpuMs: null,
      networkEgressBytes: null,
      networkIngressBytes: null,
    }),
    writeFiles: async () => undefined,
  };
  return { commands, directories, session };
}
