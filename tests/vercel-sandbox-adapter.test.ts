import { describe, expect, it, vi } from "vitest";

import { VercelSandboxProvider } from "@/execution/vercel-sandbox";

function harness() {
  const finished = {
    durationMs: 27,
    exitCode: 1,
    stderr: vi.fn(async () => "failure\n"),
    stdout: vi.fn(async () => "output\n"),
  };
  const snapshot = {
    delete: vi.fn(async () => undefined),
    snapshotId: "snap_synthetic_1",
  };
  const sandbox = {
    activeCpuUsageMs: 41,
    mkDir: vi.fn(async () => undefined),
    name: "rf-opaque-sandbox",
    networkTransfer: { egress: 13, ingress: 29 },
    readFileToBuffer: vi.fn(async () => Buffer.from("contents")),
    runCommand: vi.fn(async () => finished),
    snapshot: vi.fn(async () => snapshot),
    stop: vi.fn(async () => undefined),
    update: vi.fn(async () => undefined),
    writeFiles: vi.fn(async () => undefined),
  };
  const create = vi.fn(async (request: unknown) => {
    void request;
    return sandbox;
  });
  const provider = new VercelSandboxProvider({ create });
  return { create, finished, provider, sandbox, snapshot };
}

describe("Vercel Sandbox adapter", () => {
  it("creates a fresh non-persistent deny-all microVM without env or source", async () => {
    const fixture = harness();
    const session = await fixture.provider.create({
      networkPolicy: "deny-all",
      runtime: "node24",
      timeoutMs: 900_000,
      vcpus: 2,
    });

    expect(fixture.create).toHaveBeenCalledWith({
      networkPolicy: "deny-all",
      persistent: false,
      resources: { vcpus: 2 },
      runtime: "node24",
      timeout: 900_000,
    });
    expect(session.sandboxId).toBe("rf-opaque-sandbox");
    expect(fixture.create.mock.calls[0]?.[0]).not.toHaveProperty("env");
    expect(fixture.create.mock.calls[0]?.[0]).not.toHaveProperty("source");
  });

  it("maps typed network phases to current SDK update calls", async () => {
    const fixture = harness();
    const session = await fixture.provider.create({
      networkPolicy: "deny-all",
      runtime: "node22",
      timeoutMs: 60_000,
      vcpus: 2,
    });

    await session.setNetworkPolicy({
      allowedHosts: ["api.github.com", "*.githubusercontent.com"],
      kind: "allow-hosts",
      phase: "github-acquisition",
    });
    await session.setNetworkPolicy({
      allowedHosts: ["api.github.com", "codeload.github.com"],
      injection: {
        authorizationHeader: "Bearer synthetic-installation-token",
        host: "api.github.com",
        method: "GET",
        path: `/repos/GhostlyGawd/reproforge/tarball/${"a".repeat(40)}`,
      },
      kind: "brokered-allow-hosts",
      phase: "github-acquisition",
    });
    await session.setNetworkPolicy({ kind: "deny-all" });

    expect(fixture.sandbox.update.mock.calls).toEqual([
      [{ networkPolicy: { allow: ["api.github.com", "*.githubusercontent.com"] } }],
      [
        {
          networkPolicy: {
            allow: {
              "api.github.com": [
                {
                  match: {
                    method: ["GET"],
                    path: {
                      exact: `/repos/GhostlyGawd/reproforge/tarball/${"a".repeat(40)}`,
                    },
                  },
                  transform: [
                    {
                      headers: {
                        authorization: "Bearer synthetic-installation-token",
                      },
                    },
                  ],
                },
              ],
              "codeload.github.com": [],
            },
          },
        },
      ],
      [{ networkPolicy: "deny-all" }],
    ]);
  });

  it("runs only separated commands with SDK-enforced timeout and cancellation", async () => {
    const fixture = harness();
    const session = await fixture.provider.create({
      networkPolicy: "deny-all",
      runtime: "node24",
      timeoutMs: 60_000,
      vcpus: 2,
    });
    const controller = new AbortController();
    const result = await session.run(
      {
        args: ["run", "test:reproduce", "--", "--testNamePattern", "a b"],
        cwd: "/vercel/sandbox/workspaces/candidate-1",
        executable: "npm",
        phase: "candidate",
        timeoutMs: 120_000,
      },
      { signal: controller.signal },
    );

    expect(fixture.sandbox.runCommand).toHaveBeenCalledWith({
      args: ["run", "test:reproduce", "--", "--testNamePattern", "a b"],
      cmd: "npm",
      cwd: "/vercel/sandbox/workspaces/candidate-1",
      signal: controller.signal,
      timeoutMs: 120_000,
    });
    expect(result).toEqual({
      durationMs: 27,
      exitCode: 1,
      stderr: new TextEncoder().encode("failure\n"),
      stdout: new TextEncoder().encode("output\n"),
    });
    expect(JSON.stringify(fixture.sandbox.runCommand.mock.calls)).not.toContain(
      "sudo",
    );
    expect(JSON.stringify(fixture.sandbox.runCommand.mock.calls)).not.toContain(
      "env",
    );
  });

  it("keeps file IO inside the sandbox and exposes sanitized resource usage", async () => {
    const fixture = harness();
    const session = await fixture.provider.create({
      networkPolicy: "deny-all",
      runtime: "node24",
      timeoutMs: 60_000,
      vcpus: 2,
    });
    await session.makeDirectory("/vercel/sandbox/workspaces/source");
    await session.writeFiles([
      {
        content: new TextEncoder().encode("hello"),
        path: "/vercel/sandbox/workspaces/source/hello.txt",
      },
    ]);
    await expect(
      session.readFile("/vercel/sandbox/workspaces/source/hello.txt"),
    ).resolves.toEqual(new TextEncoder().encode("contents"));
    await expect(session.usage()).resolves.toEqual({
      activeCpuMs: 41,
      networkEgressBytes: 13,
      networkIngressBytes: 29,
    });
    await expect(
      session.readFile("/vercel/sandbox/workspaces/source/../../etc/passwd"),
    ).rejects.toThrow("sandbox path");
    expect(fixture.sandbox.mkDir).toHaveBeenCalledWith(
      "/vercel/sandbox/workspaces/source",
    );
    expect(fixture.sandbox.writeFiles).toHaveBeenCalledWith([
      {
        content: new TextEncoder().encode("hello"),
        path: "/vercel/sandbox/workspaces/source/hello.txt",
      },
    ]);
  });

  it("stops the provider exactly once across duplicate cleanup attempts", async () => {
    const fixture = harness();
    const session = await fixture.provider.create({
      networkPolicy: "deny-all",
      runtime: "node24",
      timeoutMs: 60_000,
      vcpus: 2,
    });

    await Promise.all([session.stop(), session.stop(), session.stop()]);
    expect(fixture.sandbox.stop).toHaveBeenCalledTimes(1);
  });

  it("snapshots a prepared VM and restores fresh deny-all sessions", async () => {
    const fixture = harness();
    const controller = new AbortController();
    const prepared = await fixture.provider.create({
      networkPolicy: "deny-all",
      runtime: "node24",
      timeoutMs: 60_000,
      vcpus: 2,
    });
    const snapshot = await prepared.snapshot(86_400_000, {
      signal: controller.signal,
    });
    const restored = await fixture.provider.createFromSnapshot({
      networkPolicy: "deny-all",
      snapshotId: snapshot.snapshotId,
      timeoutMs: 180_000,
      vcpus: 2,
    }, {
      signal: controller.signal,
    });

    expect(fixture.sandbox.snapshot).toHaveBeenCalledWith({
      expiration: 86_400_000,
      signal: controller.signal,
    });
    expect(fixture.create).toHaveBeenLastCalledWith({
      networkPolicy: "deny-all",
      persistent: false,
      resources: { vcpus: 2 },
      signal: controller.signal,
      source: { snapshotId: "snap_synthetic_1", type: "snapshot" },
      timeout: 180_000,
    });
    expect(restored.sandboxId).toBe("rf-opaque-sandbox");
    await snapshot.delete();
    expect(fixture.snapshot.delete).toHaveBeenCalledTimes(1);
  });

  it("rejects snapshot retention below the provider minimum before an API call", async () => {
    const fixture = harness();
    const prepared = await fixture.provider.create({
      networkPolicy: "deny-all",
      runtime: "node24",
      timeoutMs: 180_000,
      vcpus: 2,
    });

    await expect(prepared.snapshot(300_000)).rejects.toThrow();
    expect(fixture.sandbox.snapshot).not.toHaveBeenCalled();
  });
});
