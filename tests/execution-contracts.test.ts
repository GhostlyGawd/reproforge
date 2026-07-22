import { describe, expect, it } from "vitest";

import {
  immutableRepositorySourceSchema,
  nodeRepositoryProfileSchema,
  repositoryExecutionPlanSchema,
  sandboxCommandSchema,
  sandboxCreateRequestSchema,
} from "@/execution/contracts";

const SHA = "0123456789abcdef0123456789abcdef01234567";

describe("isolated execution contracts", () => {
  it("accepts only the explicit first-production Node profile", () => {
    expect(
      nodeRepositoryProfileSchema.parse({
        controlScript: "test:control",
        ecosystem: "node",
        lockfile: "package-lock.json",
        nodeVersion: "24",
        packageManager: "npm",
        reproductionScript: "test:reproduce",
        testNamePattern: "path with spaces",
        workspace: "packages/cli",
      }),
    ).toEqual({
      controlScript: "test:control",
      ecosystem: "node",
      lockfile: "package-lock.json",
      nodeVersion: "24",
      packageManager: "npm",
      reproductionScript: "test:reproduce",
      testNamePattern: "path with spaces",
      workspace: "packages/cli",
    });

    for (const profile of [
      {
        controlScript: "test:control",
        ecosystem: "node",
        lockfile: "yarn.lock",
        nodeVersion: "24",
        packageManager: "yarn",
        reproductionScript: "test:reproduce",
      },
      {
        controlScript: "test:control",
        ecosystem: "node",
        lockfile: "package-lock.json",
        nodeVersion: "23",
        packageManager: "npm",
        reproductionScript: "test:reproduce",
      },
      {
        controlScript: "test:control",
        ecosystem: "node",
        lockfile: "package-lock.json",
        nodeVersion: "24",
        packageManager: "npm",
        reproductionScript: "test:reproduce",
        workspace: "../../escape",
      },
      {
        controlScript: "test:control\u0000",
        ecosystem: "node",
        lockfile: "package-lock.json",
        nodeVersion: "24",
        packageManager: "npm",
        reproductionScript: "test:reproduce",
      },
    ]) {
      expect(nodeRepositoryProfileSchema.safeParse(profile).success).toBe(false);
    }
  });

  it("canonicalizes one immutable authorized repository descriptor", () => {
    expect(
      immutableRepositorySourceSchema.parse({
        commitSha: SHA,
        fullName: "GhostlyGawd/reproforge",
        private: false,
        provider: "github",
        repositoryId: "repo_opaque_1",
      }),
    ).toEqual({
      commitSha: SHA,
      fullName: "GhostlyGawd/reproforge",
      private: false,
      provider: "github",
      repositoryId: "repo_opaque_1",
    });

    expect(
      immutableRepositorySourceSchema.safeParse({
        commitSha: "main",
        fullName: "GhostlyGawd/reproforge",
        private: false,
        provider: "github",
        repositoryId: "repo_opaque_1",
      }).success,
    ).toBe(false);
  });

  it("creates a secretless deny-all microVM contract", () => {
    expect(
      sandboxCreateRequestSchema.parse({
        networkPolicy: "deny-all",
        runtime: "node24",
        timeoutMs: 900_000,
        vcpus: 2,
      }),
    ).toEqual({
      networkPolicy: "deny-all",
      runtime: "node24",
      timeoutMs: 900_000,
      vcpus: 2,
    });
    expect(
      sandboxCreateRequestSchema.safeParse({
        env: { DATABASE_URL: "must-not-cross-boundary" },
        networkPolicy: "allow-all",
        runtime: "node24",
        timeoutMs: 900_000,
        vcpus: 2,
      }).success,
    ).toBe(false);
  });

  it("requires executable and arguments to remain separated in a bounded workspace", () => {
    expect(
      sandboxCommandSchema.parse({
        args: ["run", "test:reproduce", "--", "--testNamePattern", "a b"],
        cwd: "/vercel/sandbox/workspaces/candidate-1/packages/cli",
        executable: "npm",
        phase: "candidate",
        timeoutMs: 120_000,
      }),
    ).toMatchObject({ executable: "npm", phase: "candidate" });

    for (const command of [
      {
        args: [],
        cwd: "/tmp/host",
        executable: "npm",
        phase: "candidate",
        timeoutMs: 120_000,
      },
      {
        args: ["test && curl example.com"],
        cwd: "/vercel/sandbox/workspaces/candidate-1",
        executable: "sh",
        phase: "candidate",
        timeoutMs: 120_000,
      },
      {
        args: ["run", "test"],
        command: "npm run test",
        cwd: "/vercel/sandbox/workspaces/candidate-1",
        executable: "npm",
        phase: "candidate",
        timeoutMs: 120_000,
      },
    ]) {
      expect(sandboxCommandSchema.safeParse(command).success).toBe(false);
    }
  });

  it("requires an offline install, one control, and the exact candidate budget", () => {
    const base = "/vercel/sandbox/workspaces";
    const command = (
      phase: "dependency-acquisition" | "offline-install" | "control" | "candidate",
      workspace: string,
    ) => ({
      args: ["run", phase],
      cwd: `${base}/${workspace}`,
      executable: "npm" as const,
      phase,
      timeoutMs: 120_000,
    });
    const input = {
      commands: [
        command("dependency-acquisition", "source"),
        command("offline-install", "source"),
        command("control", "control"),
        command("candidate", "candidate-1"),
        command("candidate", "candidate-2"),
        command("candidate", "candidate-3"),
      ],
      policyVersion: "node-npm-v1",
      profile: {
        controlScript: "test:control",
        ecosystem: "node",
        lockfile: "package-lock.json",
        nodeVersion: "24",
        packageManager: "npm",
        reproductionScript: "test:reproduce",
      },
      requiredRuns: 3,
      schemaVersion: "1.0",
      source: {
        commitSha: SHA,
        fullName: "GhostlyGawd/reproforge",
        private: false,
        provider: "github",
        repositoryId: "repo_opaque_1",
      },
      totalTimeoutMs: 900_000,
    };

    expect(repositoryExecutionPlanSchema.parse(input)).toEqual(input);
    expect(
      repositoryExecutionPlanSchema.safeParse({
        ...input,
        commands: input.commands.filter((item) => item.phase !== "control"),
      }).success,
    ).toBe(false);
    expect(
      repositoryExecutionPlanSchema.safeParse({
        ...input,
        requiredRuns: 2,
      }).success,
    ).toBe(false);
  });
});
