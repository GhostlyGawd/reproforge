import { describe, expect, it, vi } from "vitest";

import type {
  IsolatedSandboxProvider,
  IsolatedSandboxSession,
} from "@/execution/contracts";
import { createSandboxRunnerHealthProbe } from "@/infrastructure/operations/runtime-health";

function sessionFixture(input: { exitCode?: number; stdout?: string } = {}) {
  const session: IsolatedSandboxSession = {
    makeDirectory: vi.fn(async () => undefined),
    readFile: vi.fn(async () => null),
    run: vi.fn(async () => ({
      durationMs: 2,
      exitCode: input.exitCode ?? 0,
      stderr: new Uint8Array(),
      stdout: new TextEncoder().encode(
        input.stdout ?? "reproforge-runner-ready\n",
      ),
    })),
    sandboxId: "sandbox_health_opaque",
    setNetworkPolicy: vi.fn(async () => undefined),
    snapshot: vi.fn(async () => ({
      delete: async () => undefined,
      snapshotId: "snapshot_health_opaque",
    })),
    stop: vi.fn(async () => undefined),
    usage: vi.fn(async () => ({
      activeCpuMs: 1,
      networkEgressBytes: 0,
      networkIngressBytes: 0,
    })),
    writeFiles: vi.fn(async () => undefined),
  };
  return session;
}

function providerFixture(session: IsolatedSandboxSession) {
  const create = vi.fn(async () => session);
  const provider: IsolatedSandboxProvider = {
    create,
    createFromSnapshot: vi.fn(async () => session),
  };
  return { create, provider };
}

describe("sandbox runner health probe", () => {
  it("proves node execution under deny-all and always stops the sandbox", async () => {
    const session = sessionFixture();
    const provider = providerFixture(session);
    let now = 1_000;
    const probe = createSandboxRunnerHealthProbe({
      cacheTtlMs: 60_000,
      clock: { now: () => now },
      provider: provider.provider,
    });

    await expect(probe.check()).resolves.toEqual({
      code: "RUNNER_READY",
      status: "ready",
    });
    now += 5_000;
    await expect(probe.check()).resolves.toEqual({
      code: "RUNNER_READY",
      status: "ready",
    });

    expect(provider.create).toHaveBeenCalledTimes(1);
    expect(provider.create).toHaveBeenCalledWith({
      networkPolicy: "deny-all",
      runtime: "node24",
      timeoutMs: 30_000,
      vcpus: 2,
    });
    expect(session.makeDirectory).toHaveBeenCalledWith(
      "/vercel/sandbox/workspaces",
    );
    expect(session.makeDirectory).toHaveBeenCalledWith(
      "/vercel/sandbox/workspaces/health",
    );
    expect(session.run).toHaveBeenCalledWith({
      args: ["-e", 'process.stdout.write("reproforge-runner-ready\\n")'],
      cwd: "/vercel/sandbox/workspaces/health",
      executable: "node",
      phase: "control",
      timeoutMs: 5_000,
    });
    expect(session.stop).toHaveBeenCalledTimes(1);
  });

  it("fails closed and cleans up when the capability command is unhealthy", async () => {
    const session = sessionFixture({ exitCode: 1, stdout: "unexpected" });
    const provider = providerFixture(session);
    const probe = createSandboxRunnerHealthProbe({
      cacheTtlMs: 0,
      clock: { now: () => 1_000 },
      provider: provider.provider,
    });

    await expect(probe.check()).resolves.toEqual({
      code: "RUNNER_UNAVAILABLE",
      status: "unavailable",
    });
    expect(session.stop).toHaveBeenCalledTimes(1);
  });

  it("fails closed without disclosing provider errors", async () => {
    const provider: IsolatedSandboxProvider = {
      create: vi.fn(async () => {
        throw new Error("VERCEL_OIDC_TOKEN=synthetic-secret");
      }),
      createFromSnapshot: vi.fn(async () => {
        throw new Error("not used");
      }),
    };
    const probe = createSandboxRunnerHealthProbe({
      cacheTtlMs: 0,
      clock: { now: () => 1_000 },
      provider,
    });

    const result = await probe.check();
    expect(result).toEqual({
      code: "RUNNER_UNAVAILABLE",
      status: "unavailable",
    });
    expect(JSON.stringify(result)).not.toContain("synthetic-secret");
  });
});
