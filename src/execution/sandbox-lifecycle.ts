import { z } from "zod";

import type {
  IsolatedSandboxProvider,
  IsolatedSandboxSession,
  IsolatedSandboxSnapshot,
} from "@/execution/contracts";
import {
  SANDBOX_SNAPSHOT_MAX_EXPIRATION_MS,
  SANDBOX_SNAPSHOT_MIN_EXPIRATION_MS,
} from "@/execution/contracts";
import { ExecutionLimitError } from "@/execution/bounded-execution";

export type CleanupStatus = "clean" | "quarantined";
export type AttemptLifecycleCode =
  | "ATTEMPT_TIMEOUT"
  | "CANCELLED"
  | "EXECUTION_FAILED"
  | "PROVIDER_INTERRUPTED";

export class AttemptLifecycleError extends Error {
  constructor(
    readonly code: AttemptLifecycleCode,
    readonly cleanupStatus: CleanupStatus,
  ) {
    super("The isolated attempt did not complete its provider lifecycle");
    this.name = "AttemptLifecycleError";
  }
}

export type QuarantineRecord = {
  attemptId: string;
  providerResourceId: string;
  reason: "cleanup-failed";
  resourceType: "sandbox" | "snapshot";
};

export interface SandboxQuarantineSink {
  record(input: QuarantineRecord): Promise<void>;
}

type Dependencies = {
  attemptTimeoutMs?: number;
  maxProviderRetries?: number;
  provider: IsolatedSandboxProvider;
  quarantine: SandboxQuarantineSink;
  snapshotExpirationMs?: number;
};

type ExecuteInput<Result> = {
  attemptId: string;
  preparedSession: IsolatedSandboxSession;
  run: (input: {
    index: number;
    session: IsolatedSandboxSession;
    signal: AbortSignal;
  }) => Promise<Result>;
  runCount: number;
  signal?: AbortSignal;
};

export type SnapshotRunResult<Result> = {
  cleanupStatus: CleanupStatus;
  providerRetries: number;
  values: Result[];
};

function isProviderInterruption(error: unknown): boolean {
  return (
    error instanceof ExecutionLimitError &&
    error.code === "PROVIDER_INTERRUPTED"
  );
}

export class SnapshotRunCoordinator {
  private readonly attemptTimeoutMs: number;
  private readonly cleanup = new WeakMap<IsolatedSandboxSession, Promise<void>>();
  private readonly maxProviderRetries: number;
  private readonly snapshotExpirationMs: number;

  constructor(private readonly dependencies: Dependencies) {
    this.attemptTimeoutMs = z
      .number()
      .int()
      .min(1)
      .max(900_000)
      .parse(dependencies.attemptTimeoutMs ?? 900_000);
    this.maxProviderRetries = z
      .number()
      .int()
      .min(0)
      .max(1)
      .parse(dependencies.maxProviderRetries ?? 1);
    this.snapshotExpirationMs = z
      .number()
      .int()
      .min(SANDBOX_SNAPSHOT_MIN_EXPIRATION_MS)
      .max(SANDBOX_SNAPSHOT_MAX_EXPIRATION_MS)
      .parse(
        dependencies.snapshotExpirationMs ??
          SANDBOX_SNAPSHOT_MIN_EXPIRATION_MS,
      );
  }

  async execute<Result>(rawInput: ExecuteInput<Result>): Promise<SnapshotRunResult<Result>> {
    const attemptId = z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
      .parse(rawInput.attemptId);
    const runCount = z.number().int().min(1).max(6).parse(rawInput.runCount);
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.attemptTimeoutMs);
    const cancel = () => controller.abort();
    if (rawInput.signal?.aborted) cancel();
    rawInput.signal?.addEventListener("abort", cancel, { once: true });

    let cleanupStatus: CleanupStatus = "clean";
    let snapshot: IsolatedSandboxSnapshot | undefined;
    let lifecycleError: AttemptLifecycleError | undefined;
    let providerRetries = 0;
    const values: Result[] = [];

    const quarantine = async (record: QuarantineRecord) => {
      cleanupStatus = "quarantined";
      try {
        await this.dependencies.quarantine.record(record);
      } catch {
        // The cleanup state remains quarantined even if alert delivery fails.
      }
    };

    const cleanupSession = (session: IsolatedSandboxSession): Promise<void> => {
      const existing = this.cleanup.get(session);
      if (existing) return existing;
      const pending = session.stop().catch(async () => {
        await quarantine({
          attemptId,
          providerResourceId: session.sandboxId,
          reason: "cleanup-failed",
          resourceType: "sandbox",
        });
      });
      this.cleanup.set(session, pending);
      return pending;
    };

    const abortedError = () =>
      new AttemptLifecycleError(
        timedOut ? "ATTEMPT_TIMEOUT" : "CANCELLED",
        cleanupStatus,
      );

    try {
      if (controller.signal.aborted) throw abortedError();
      try {
        snapshot = await rawInput.preparedSession.snapshot(
          this.snapshotExpirationMs,
          { signal: controller.signal },
        );
      } catch {
        if (controller.signal.aborted) throw abortedError();
        throw new AttemptLifecycleError("PROVIDER_INTERRUPTED", cleanupStatus);
      }
      await cleanupSession(rawInput.preparedSession);

      for (let index = 0; index < runCount; index += 1) {
        let retries = 0;
        while (true) {
          if (controller.signal.aborted) throw abortedError();
          let session: IsolatedSandboxSession;
          try {
            session = await this.dependencies.provider.createFromSnapshot({
              networkPolicy: "deny-all",
              snapshotId: snapshot.snapshotId,
              timeoutMs: 180_000,
              vcpus: 2,
            }, { signal: controller.signal });
          } catch {
            if (controller.signal.aborted) throw abortedError();
            if (retries < this.maxProviderRetries) {
              retries += 1;
              providerRetries += 1;
              continue;
            }
            throw new AttemptLifecycleError(
              "PROVIDER_INTERRUPTED",
              cleanupStatus,
            );
          }

          const cancelActive = () => {
            void cleanupSession(session);
          };
          controller.signal.addEventListener("abort", cancelActive, {
            once: true,
          });
          let retry = false;
          try {
            const value = await rawInput.run({
              index,
              session,
              signal: controller.signal,
            });
            if (controller.signal.aborted) throw abortedError();
            values.push(value);
          } catch (error) {
            if (controller.signal.aborted) throw abortedError();
            if (
              isProviderInterruption(error) &&
              retries < this.maxProviderRetries
            ) {
              retries += 1;
              providerRetries += 1;
              retry = true;
            } else if (isProviderInterruption(error)) {
              throw new AttemptLifecycleError(
                "PROVIDER_INTERRUPTED",
                cleanupStatus,
              );
            } else if (error instanceof AttemptLifecycleError) {
              throw error;
            } else {
              throw new AttemptLifecycleError(
                "EXECUTION_FAILED",
                cleanupStatus,
              );
            }
          } finally {
            controller.signal.removeEventListener("abort", cancelActive);
            await cleanupSession(session);
          }
          if (retry) continue;
          break;
        }
      }
    } catch (error) {
      lifecycleError =
        error instanceof AttemptLifecycleError
          ? error
          : new AttemptLifecycleError("EXECUTION_FAILED", cleanupStatus);
    } finally {
      await cleanupSession(rawInput.preparedSession);
      if (snapshot) {
        try {
          await snapshot.delete();
        } catch {
          await quarantine({
            attemptId,
            providerResourceId: snapshot.snapshotId,
            reason: "cleanup-failed",
            resourceType: "snapshot",
          });
        }
      }
      clearTimeout(timeout);
      rawInput.signal?.removeEventListener("abort", cancel);
    }

    if (lifecycleError) {
      throw new AttemptLifecycleError(lifecycleError.code, cleanupStatus);
    }
    return { cleanupStatus, providerRetries, values };
  }
}
