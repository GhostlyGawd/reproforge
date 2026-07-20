import { describe, expect, it, vi } from "vitest";

import type {
  IsolatedSandboxProvider,
  IsolatedSandboxSession,
  IsolatedSandboxSnapshot,
  SandboxCommandResult,
} from "@/execution/contracts";
import { ExecutionLimitError } from "@/execution/bounded-execution";
import {
  AttemptLifecycleError,
  SnapshotRunCoordinator,
} from "@/execution/sandbox-lifecycle";

describe("snapshot-isolated sandbox lifecycle", () => {
  it("restores a fresh microVM for every run and cleans all provider resources", async () => {
    const fixture = harness(4);
    const coordinator = new SnapshotRunCoordinator({
      provider: fixture.provider,
      quarantine: { record: fixture.quarantine },
    });
    const results = await coordinator.execute({
      attemptId: "attempt_1",
      preparedSession: fixture.prepared,
      runCount: 4,
      run: async ({ index, session }) => `${index}:${session.sandboxId}`,
    });

    expect(results.values).toEqual([
      "0:restored_1",
      "1:restored_2",
      "2:restored_3",
      "3:restored_4",
    ]);
    expect(results.cleanupStatus).toBe("clean");
    expect(results.providerRetries).toBe(0);
    expect(fixture.createFromSnapshot).toHaveBeenCalledTimes(4);
    expect(fixture.sessions.every(({ stop }) => stop.mock.calls.length === 1)).toBe(
      true,
    );
    expect(fixture.snapshot.delete).toHaveBeenCalledTimes(1);
    expect(fixture.quarantine).not.toHaveBeenCalled();
  });

  it("retries one provider interruption in a fresh VM", async () => {
    const fixture = harness(2);
    const coordinator = new SnapshotRunCoordinator({
      maxProviderRetries: 1,
      provider: fixture.provider,
      quarantine: { record: fixture.quarantine },
    });
    let calls = 0;
    const result = await coordinator.execute({
      attemptId: "attempt_retry",
      preparedSession: fixture.prepared,
      runCount: 1,
      run: async ({ session }) => {
        calls += 1;
        if (calls === 1) {
          throw new ExecutionLimitError("PROVIDER_INTERRUPTED");
        }
        return session.sandboxId;
      },
    });

    expect(result.values).toEqual(["restored_2"]);
    expect(result.providerRetries).toBe(1);
    expect(fixture.sessions[0]?.stop).toHaveBeenCalledTimes(1);
    expect(fixture.sessions[1]?.stop).toHaveBeenCalledTimes(1);
  });

  it("streams user cancellation into the active run and stops its VM", async () => {
    const fixture = harness(1);
    const controller = new AbortController();
    const coordinator = new SnapshotRunCoordinator({
      provider: fixture.provider,
      quarantine: { record: fixture.quarantine },
    });
    const started = Promise.withResolvers<void>();
    const execution = coordinator.execute({
      attemptId: "attempt_cancel",
      preparedSession: fixture.prepared,
      runCount: 1,
      signal: controller.signal,
      run: async ({ signal }) => {
        started.resolve();
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("cancelled", "AbortError")),
            { once: true },
          );
        });
        return "unreachable";
      },
    });
    await started.promise;
    controller.abort();

    await expect(execution).rejects.toMatchObject({ code: "CANCELLED" });
    expect(fixture.sessions[0]?.stop).toHaveBeenCalledTimes(1);
    expect(fixture.snapshot.delete).toHaveBeenCalledTimes(1);
  });

  it("enforces one total attempt timeout without fabricating a result", async () => {
    const fixture = harness(1);
    const coordinator = new SnapshotRunCoordinator({
      attemptTimeoutMs: 20,
      provider: fixture.provider,
      quarantine: { record: fixture.quarantine },
    });

    await expect(
      coordinator.execute({
        attemptId: "attempt_timeout",
        preparedSession: fixture.prepared,
        runCount: 1,
        run: async ({ signal }) => {
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => reject(new DOMException("timeout", "AbortError")),
              { once: true },
            );
          });
          return "unreachable";
        },
      }),
    ).rejects.toMatchObject({ code: "ATTEMPT_TIMEOUT" });
    expect(fixture.sessions[0]?.stop).toHaveBeenCalledTimes(1);
  });

  it("reports execution resource limits as budget exhaustion and cleans resources", async () => {
    const fixture = harness(1);
    const coordinator = new SnapshotRunCoordinator({
      provider: fixture.provider,
      quarantine: { record: fixture.quarantine },
    });

    await expect(
      coordinator.execute({
        attemptId: "attempt_budget",
        preparedSession: fixture.prepared,
        runCount: 1,
        run: async () => {
          throw new ExecutionLimitError("WORKSPACE_LIMIT_EXCEEDED");
        },
      }),
    ).rejects.toMatchObject({ code: "BUDGET_EXHAUSTED" });
    expect(fixture.sessions[0]?.stop).toHaveBeenCalledTimes(1);
    expect(fixture.snapshot.delete).toHaveBeenCalledTimes(1);
    expect(fixture.quarantine).not.toHaveBeenCalled();
  });

  it("aborts provider restore at the total attempt deadline without retrying", async () => {
    const fixture = harness(0);
    fixture.provider.createFromSnapshot = vi.fn(
      async (_request, options) =>
        new Promise<IsolatedSandboxSession>((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("timeout", "AbortError")),
            { once: true },
          );
        }),
    );
    const coordinator = new SnapshotRunCoordinator({
      attemptTimeoutMs: 20,
      provider: fixture.provider,
      quarantine: { record: fixture.quarantine },
    });

    await expect(
      coordinator.execute({
        attemptId: "attempt_restore_timeout",
        preparedSession: fixture.prepared,
        runCount: 1,
        run: async () => "unreachable",
      }),
    ).rejects.toMatchObject({ code: "ATTEMPT_TIMEOUT" });
    expect(fixture.provider.createFromSnapshot).toHaveBeenCalledTimes(1);
    expect(fixture.snapshot.delete).toHaveBeenCalledTimes(1);
  });

  it("quarantines cleanup failure without changing completed run values", async () => {
    const fixture = harness(1, { stopFailure: true });
    const coordinator = new SnapshotRunCoordinator({
      provider: fixture.provider,
      quarantine: { record: fixture.quarantine },
    });
    const result = await coordinator.execute({
      attemptId: "attempt_quarantine",
      preparedSession: fixture.prepared,
      runCount: 1,
      run: async () => "machine-proof-value",
    });

    expect(result.values).toEqual(["machine-proof-value"]);
    expect(result.cleanupStatus).toBe("quarantined");
    expect(fixture.quarantine).toHaveBeenCalledWith({
      attemptId: "attempt_quarantine",
      providerResourceId: "restored_1",
      reason: "cleanup-failed",
      resourceType: "sandbox",
    });
  });

  it("exposes only sanitized lifecycle errors", () => {
    expect(new AttemptLifecycleError("EXECUTION_FAILED", "clean")).toEqual(
      expect.objectContaining({
        cleanupStatus: "clean",
        code: "EXECUTION_FAILED",
      }),
    );
  });
});

function harness(count: number, options: { stopFailure?: boolean } = {}) {
  const snapshot: IsolatedSandboxSnapshot & { delete: ReturnType<typeof vi.fn> } = {
    delete: vi.fn(async () => undefined),
    snapshotId: "snap_prepared_1",
  };
  const prepared = session("prepared", {
    snapshot: async () => snapshot,
  });
  const sessions = Array.from({ length: count }, (_, index) =>
    session(`restored_${index + 1}`, {
      stop: vi.fn(async () => {
        if (options.stopFailure) throw new Error("synthetic provider detail");
      }),
    }),
  );
  let sequence = 0;
  const createFromSnapshot = vi.fn(async () => {
    const next = sessions[sequence];
    sequence += 1;
    if (!next) throw new Error("unexpected extra sandbox");
    return next;
  });
  const provider: IsolatedSandboxProvider = {
    create: async () => {
      throw new Error("not used");
    },
    createFromSnapshot,
  };
  return {
    createFromSnapshot,
    prepared,
    provider,
    quarantine: vi.fn(async () => undefined),
    sessions,
    snapshot,
  };
}

function session(
  sandboxId: string,
  overrides: Partial<IsolatedSandboxSession> = {},
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
      snapshotId: "snap_default",
    }),
    stop: vi.fn(async () => undefined),
    usage: async () => ({
      activeCpuMs: null,
      networkEgressBytes: null,
      networkIngressBytes: null,
    }),
    writeFiles: async () => undefined,
    ...overrides,
  } as IsolatedSandboxSession & { stop: ReturnType<typeof vi.fn> };
}
