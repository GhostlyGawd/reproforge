import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  BoundedExperimentExecutor,
  EXECUTION_LIMITS,
} from "@/execution/bounded-execution";
import type {
  ImmutableRepositorySource,
  IsolatedSandboxSession,
  SandboxCommand,
} from "@/execution/contracts";
import type { ExecutionEnvironmentProvenance } from "@/execution/execution-planning";
import { downloadGitHubArchive } from "@/execution/github-source-acquisition";
import { SnapshotRunCoordinator } from "@/execution/sandbox-lifecycle";
import { SOURCE_LIMITS } from "@/execution/source-provenance";
import { VercelSandboxProvider } from "@/execution/vercel-sandbox";
import {
  PUBLIC_REPOSITORY_CANARY_SECRET,
  runPublicRepositoryCanary,
} from "../../scripts/public-repository-canary";

vi.setConfig({ hookTimeout: 300_000, testTimeout: 300_000 });

const LIVE = process.env.REPROFORGE_LIVE_PROVIDER_TESTS === "1";
const workspace = "/vercel/sandbox/workspaces/provider-canary";
const syntheticSecret =
  "SYNTHETIC_GITHUB_INSTALLATION_SECRET_FOR_REPROFORGE_CANARY";

describe.skipIf(!LIVE)("live isolated execution provider", () => {
  it("produces a portable verified bundle from an immutable public repository", async () => {
    requireProviderIdentity();
    const { proof, quarantine } = await runPublicRepositoryCanary();

    expect(proof).toMatchObject({
      bundle: expect.objectContaining({ schemaVersion: "1.1" }),
      case: { state: "VERIFIED" },
      provenance: {
        cleanupStatus: "clean",
        environment: { networkPolicy: "deny-all", provider: "vercel-sandbox" },
        source: { provider: "github" },
      },
      summary: { controlMatched: false, repeatability: 1, status: "VERIFIED" },
    });
    expect(proof.runs).toHaveLength(4);
    expect(Object.keys(proof.files).length).toBeGreaterThan(0);
    expect(JSON.stringify(proof)).not.toContain(PUBLIC_REPOSITORY_CANARY_SECRET);
    expect(quarantine).toEqual([]);
  });

  it("injects trusted-host source bytes while enforcing deny-all, limits, and cancellation", async () => {
    requireProviderIdentity();
    const source = await resolvePublicCanarySource();
    const archive = await downloadGitHubArchive({ source });
    const expectedArchiveHash = createHash("sha256").update(archive).digest("hex");
    expect(archive.byteLength).toBeGreaterThan(0);
    expect(archive.byteLength).toBeLessThanOrEqual(SOURCE_LIMITS.maxArchiveBytes);

    const provider = new VercelSandboxProvider();
    const session = await provider.create({
      networkPolicy: "deny-all",
      runtime: "node24",
      timeoutMs: 180_000,
      vcpus: 2,
    });

    try {
      await session.makeDirectory("/vercel/sandbox/workspaces");
      await session.makeDirectory(workspace);
      await session.setNetworkPolicy({ kind: "deny-all" });
      await session.writeFiles([
        { content: archive, path: `${workspace}/source.tar.gz` },
      ]);
      archive.fill(0);
      const hashed = await session.run(
        command("source-acquisition", "sha256sum", ["source.tar.gz"]),
      );
      expect(hashed.exitCode).toBe(0);
      expect(new TextDecoder().decode(hashed.stdout)).toMatch(
        new RegExp(`^${expectedArchiveHash}\\s+source\\.tar\\.gz`),
      );
      const listed = await session.run(
        command("source-acquisition", "tar", [
          "--list",
          "--gzip",
          "--file",
          "source.tar.gz",
        ]),
      );
      expect(listed.exitCode).toBe(0);
      expect(listed.stdout.byteLength).toBeGreaterThan(0);

      const denied = await session.run(
        command("candidate", "curl", [
          "--connect-timeout",
          "3",
          "--max-time",
          "5",
          "--silent",
          "--show-error",
          "https://api.github.com/repos/GhostlyGawd/reproforge",
        ]),
      );
      expect(denied.exitCode).not.toBe(0);

      const observed = await observableSurfaces(session);
      expect(observed).not.toContain(syntheticSecret);
      expect(observed).not.toContain(`Bearer ${syntheticSecret}`);
      expect(observed).not.toContain("GITHUB_TOKEN");
      expect(observed).not.toContain("VERCEL_OIDC_TOKEN");

      const executor = new BoundedExperimentExecutor();
      const outputBytes = 3 * 1024 * 1024;
      const bounded = await executor.executeRun({
        command: command("candidate", "node", [
          "-e",
          `process.stdout.write("x".repeat(${outputBytes}))`,
        ]),
        environment,
        networkPolicy: "deny-all",
        runId: "provider-output-bound",
        secrets: [syntheticSecret],
        session,
      });
      expect(bounded.capture.stdout).toMatchObject({
        originalBytes: outputBytes,
        sha256: createHash("sha256")
          .update(Buffer.alloc(outputBytes, "x"))
          .digest("hex"),
        truncated: true,
      });
      expect(Buffer.byteLength(bounded.capture.stdout.text)).toBe(
        Math.floor(EXECUTION_LIMITS.maxOutputBytes / 2),
      );

      const controller = new AbortController();
      const cancellation = executor.executeRun({
        command: command("candidate", "node", ["-e", "while (true) {}"]),
        environment,
        networkPolicy: "deny-all",
        runId: "provider-cancellation",
        secrets: [],
        session,
        signal: controller.signal,
      });
      const abort = setTimeout(() => controller.abort(), 500);
      await expect(cancellation).rejects.toMatchObject({
        code: "PROVIDER_INTERRUPTED",
      });
      clearTimeout(abort);
    } finally {
      await session.stop();
    }
  });

  it("restores fresh deny-all microVMs and deletes every lifecycle resource", async () => {
    requireProviderIdentity();
    const provider = new VercelSandboxProvider();
    const prepared = await provider.create({
      networkPolicy: "deny-all",
      runtime: "node24",
      timeoutMs: 180_000,
      vcpus: 2,
    });
    await prepared.makeDirectory("/vercel/sandbox/workspaces");
    await prepared.makeDirectory(workspace);
    await prepared.writeFiles([
      {
        content: new TextEncoder().encode("immutable-marker"),
        path: `${workspace}/marker.txt`,
      },
    ]);
    const quarantined: unknown[] = [];
    const coordinator = new SnapshotRunCoordinator({
      attemptTimeoutMs: 180_000,
      provider,
      quarantine: {
        record: async (record) => {
          quarantined.push(record);
        },
      },
    });

    const result = await coordinator.execute({
      attemptId: "provider_snapshot_canary",
      preparedSession: prepared,
      run: async ({ index, session, signal }) => {
        const marker = await session.readFile(`${workspace}/marker.txt`);
        const mutation = await session.readFile(`${workspace}/mutation.txt`);
        if (index === 0) {
          await session.writeFiles([
            {
              content: new TextEncoder().encode("first-restore-only"),
              path: `${workspace}/mutation.txt`,
            },
          ]);
        }
        const execution = await session.run(
          command("candidate", "node", [
            "-e",
            `process.stdout.write("restore-${index}")`,
          ]),
          { signal },
        );
        return {
          exitCode: execution.exitCode,
          marker: marker ? new TextDecoder().decode(marker) : null,
          mutationPresent: mutation !== null,
        };
      },
      runCount: 2,
    });

    expect(result).toMatchObject({
      cleanupStatus: "clean",
      values: [
        { exitCode: 0, marker: "immutable-marker", mutationPresent: false },
        { exitCode: 0, marker: "immutable-marker", mutationPresent: false },
      ],
    });
    expect(quarantined).toEqual([]);
  });
});

function requireProviderIdentity(): void {
  if (!process.env.VERCEL_OIDC_TOKEN) {
    throw new Error("Missing live provider environment: VERCEL_OIDC_TOKEN");
  }
}

function command(
  phase: SandboxCommand["phase"],
  executable: SandboxCommand["executable"],
  args: string[],
): SandboxCommand {
  return {
    args,
    cwd: workspace,
    executable,
    phase,
    timeoutMs: 120_000,
  };
}

async function observableSurfaces(
  session: IsolatedSandboxSession,
): Promise<string> {
  const commands: SandboxCommand[] = [
    command("candidate", "node", [
      "-e",
      "process.stdout.write(JSON.stringify({argv:process.argv,env:process.env}))",
    ]),
    command("candidate", "git", ["config", "--list", "--show-origin"]),
    command("candidate", "find", [workspace, "-maxdepth", "3", "-type", "f"]),
  ];
  const results = await Promise.all(commands.map((value) => session.run(value)));
  return [
    ...results.flatMap((result) => [
      new TextDecoder().decode(result.stdout),
      new TextDecoder().decode(result.stderr),
    ]),
  ].join("\n");
}

async function resolvePublicCanarySource(): Promise<ImmutableRepositorySource> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(
      "https://api.github.com/repos/GhostlyGawd/reproforge/commits/main",
      {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "ReproForge-provider-canary/0.2",
          "X-GitHub-Api-Version": "2026-03-10",
        },
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      throw new Error("The public GitHub canary revision could not be resolved");
    }
    const payload: unknown = await response.json();
    const commitSha =
      typeof payload === "object" &&
      payload !== null &&
      "sha" in payload &&
      typeof payload.sha === "string"
        ? payload.sha
        : "";
    if (!/^[a-f0-9]{40}$/.test(commitSha)) {
      throw new Error("The public GitHub canary returned an invalid revision");
    }
    return {
      commitSha,
      fullName: "GhostlyGawd/reproforge",
      private: false,
      provider: "github",
      repositoryId: "public_provider_canary",
    };
  } finally {
    clearTimeout(timeout);
  }
}

const environment: ExecutionEnvironmentProvenance = {
  archiveSha256: "a".repeat(64),
  dependencyPolicyVersion: "node-lock-v1",
  environmentHash: "f".repeat(64),
  executionPolicyVersion: "node-npm-v1",
  lockfileSha256: "b".repeat(64),
  manifestSha256: "c".repeat(64),
  networkPolicy: "deny-all",
  nodeVersion: "24.8.0",
  npmVersion: "11.4.2",
  packageJsonSha256: "d".repeat(64),
  provider: "vercel-sandbox",
  runtime: "node24",
  schemaVersion: "1.0",
  sourceCommitSha: "e".repeat(40),
  sourcePolicyVersion: "source-archive-v1",
  vcpus: 2,
};
