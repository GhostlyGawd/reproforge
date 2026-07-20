import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type {
  IsolatedSandboxSession,
  SandboxCommand,
  SandboxCommandResult,
  SandboxFile,
} from "@/execution/contracts";
import type { ExecutionEnvironmentProvenance } from "@/execution/execution-planning";
import {
  BoundedExperimentExecutor,
  captureBoundedOutput,
  enforceArtifactBudget,
  EXECUTION_LIMITS,
  ExecutionLimitError,
} from "@/execution/bounded-execution";
import { buildNodeExecutionPlan } from "@/execution/execution-planning";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const source = {
  commitSha: SHA,
  fullName: "GhostlyGawd/reproforge",
  private: false,
  provider: "github" as const,
  repositoryId: "repo_opaque_1",
};
const profile = {
  controlScript: "test:control",
  ecosystem: "node" as const,
  lockfile: "package-lock.json" as const,
  nodeVersion: "24" as const,
  packageManager: "npm" as const,
  reproductionScript: "test:reproduce",
};
const environment: ExecutionEnvironmentProvenance = {
  archiveSha256: "a".repeat(64),
  dependencyPolicyVersion: "node-lock-v1",
  environmentHash: "e".repeat(64),
  executionPolicyVersion: "node-npm-v1",
  lockfileSha256: "b".repeat(64),
  manifestSha256: "d".repeat(64),
  networkPolicy: "deny-all",
  nodeVersion: "24.4.1",
  npmVersion: "11.4.2",
  packageJsonSha256: "c".repeat(64),
  provider: "vercel-sandbox",
  runtime: "node24",
  schemaVersion: "1.0",
  sourceCommitSha: SHA,
  sourcePolicyVersion: "source-archive-v1",
  vcpus: 2,
};

describe("bounded experiment execution", () => {
  it("runs one control and three candidates through the trusted supervisor", async () => {
    const fixture = harness();
    const plan = buildNodeExecutionPlan({ profile, requiredRuns: 3, source });
    const executor = new BoundedExperimentExecutor();
    const result = await executor.execute({
      environment,
      networkPolicy: "deny-all",
      plan,
      secrets: ["synthetic-runtime-secret"],
      session: fixture.session,
    });

    expect(result.control).toMatchObject({
      role: "control",
      run: {
        environmentHash: environment.environmentHash,
        exitCode: 0,
        id: "control-1",
      },
    });
    expect(result.candidates).toHaveLength(3);
    expect(result.candidates.map(({ run }) => run.id)).toEqual([
      "candidate-1",
      "candidate-2",
      "candidate-3",
    ]);
    expect(result.candidates[0]?.run.stderr).toContain("[REDACTED]");
    expect(JSON.stringify(result)).not.toContain("synthetic-runtime-secret");
    expect(result.limitsPolicyVersion).toBe("sandbox-limits-v1");

    const supervisor = fixture.files.find((file) =>
      file.path.endsWith("runner-supervisor.mjs"),
    );
    const sourceText = new TextDecoder().decode(supervisor?.content);
    expect(sourceText).toContain("shell: false");
    expect(sourceText).toContain("maxProcesses");
    expect(sourceText).toContain("maxWorkspaceBytes");
    expect(sourceText).not.toContain("eval(");

    const configs = fixture.files
      .filter((file) => file.path.endsWith(".config.json"))
      .map((file) => JSON.parse(new TextDecoder().decode(file.content)));
    expect(configs).toHaveLength(4);
    expect(configs[0]).toMatchObject({
      args: ["run", "test:control"],
      executable: "npm",
      limits: {
        commandTimeoutMs: 120_000,
        maxMemoryBytes: EXECUTION_LIMITS.maxMemoryBytes,
        maxOutputBytes: EXECUTION_LIMITS.maxOutputBytes,
        maxProcesses: 128,
        maxWorkspaceBytes: EXECUTION_LIMITS.maxWorkspaceBytes,
      },
      phase: "control",
    });
    expect(JSON.stringify(configs)).not.toContain("shell");
  });

  it("maps supervisor terminations to stable sanitized limit failures", async () => {
    const fixture = harness({ termination: "process-limit" });
    const executor = new BoundedExperimentExecutor();
    let caught: unknown;
    try {
      await executor.execute({
        environment,
        networkPolicy: "deny-all",
        plan: buildNodeExecutionPlan({ profile, requiredRuns: 3, source }),
        secrets: [],
        session: fixture.session,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ExecutionLimitError);
    expect(caught).toMatchObject({ code: "PROCESS_LIMIT_EXCEEDED" });
    expect(JSON.stringify(caught)).not.toContain("candidate failure");
  });

  it("truncates deterministically while preserving original size and hash", () => {
    const bytes = new TextEncoder().encode("abcdef");
    expect(captureBoundedOutput(bytes, 4, [])).toEqual({
      originalBytes: 6,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      text: "abcd",
      truncated: true,
    });
  });

  it("rejects an artifact set above the hard byte budget", () => {
    expect(
      enforceArtifactBudget([
        { bytes: new Uint8Array(12), path: "artifacts/run.json" },
      ]),
    ).toEqual({ artifactBytes: 12, artifactCount: 1 });
    expect(() =>
      enforceArtifactBudget([
        {
          bytes: { byteLength: EXECUTION_LIMITS.maxArtifactBytes + 1 },
          path: "artifacts/oversized.bin",
        },
      ]),
    ).toThrow(expect.objectContaining({ code: "ARTIFACT_LIMIT_EXCEEDED" }));
  });
});

function harness(options: { termination?: string } = {}) {
  const files: SandboxFile[] = [];
  const storage = new Map<string, Uint8Array>();
  const commands: SandboxCommand[] = [];
  const encode = (value: string) => new TextEncoder().encode(value);
  const commandResult: SandboxCommandResult = {
    durationMs: 20,
    exitCode: 0,
    stderr: new Uint8Array(),
    stdout: new Uint8Array(),
  };
  const session: IsolatedSandboxSession = {
    makeDirectory: async () => undefined,
    readFile: async (path) => storage.get(path) ?? null,
    run: async (command) => {
      commands.push(command);
      const [, configPath, resultPath] = command.args;
      if (!configPath || !resultPath) throw new Error("missing supervisor paths");
      const configBytes = storage.get(configPath);
      if (!configBytes) throw new Error("missing supervisor config");
      const config = JSON.parse(new TextDecoder().decode(configBytes));
      const candidate = config.phase === "candidate";
      const stdout = candidate ? "candidate output\n" : "control output\n";
      const stderr = candidate
        ? "candidate failure synthetic-runtime-secret\n"
        : "";
      storage.set(
        resultPath,
        encode(
          JSON.stringify({
            durationMs: 25,
            exitCode: candidate ? 1 : 0,
            stderr: capture(stderr),
            stdout: capture(stdout),
            termination: options.termination ?? null,
          }),
        ),
      );
      return commandResult;
    },
    sandboxId: "sandbox_1",
    setNetworkPolicy: async () => undefined,
    stop: async () => undefined,
    usage: async () => ({
      activeCpuMs: 10,
      networkEgressBytes: 0,
      networkIngressBytes: 0,
    }),
    writeFiles: async (input) => {
      for (const file of input) {
        files.push(file);
        storage.set(file.path, file.content);
      }
    },
  };
  return { commands, files, session };
}

function capture(value: string) {
  const bytes = new TextEncoder().encode(value);
  return {
    originalBytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    text: value,
    truncated: false,
  };
}
