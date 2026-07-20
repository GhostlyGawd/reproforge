import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CaseService,
  IdempotencyConflictError,
  ReproductionNotFoundError,
  TrustedExecutionFailedError,
} from "@/application/case-service";
import { InMemoryReproductionRepository } from "@/infrastructure/reproduction-repository";
import { runTrustedSample } from "@/application/sample-case";
import { validateMaterializedBundle } from "@/domain/bundle";

function createHarness() {
  let caseSequence = 0;
  let jobSequence = 0;
  const executeTrustedSample = vi.fn(runTrustedSample);
  const service = new CaseService({
    clock: { now: () => new Date("2026-07-19T19:00:00.000Z") },
    executeTrustedSample,
    identifiers: {
      nextCaseId: () => `case-${++caseSequence}`,
      nextJobId: () => `job-${++jobSequence}`,
    },
    repository: new InMemoryReproductionRepository(),
  });

  return { executeTrustedSample, service };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("CaseService", () => {
  it("starts the trusted reproduction once and reuses it for an idempotent retry", async () => {
    const { executeTrustedSample, service } = createHarness();
    const command = {
      callerId: "chatgpt:anonymous",
      idempotencyKey: "tool-call-1",
      sampleId: "cli-spaces" as const,
    };

    const first = await service.startTrustedReproduction(command);
    const second = await service.startTrustedReproduction(command);

    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(second.snapshot.case.id).toBe(first.snapshot.case.id);
    expect(second.snapshot.job.id).toBe(first.snapshot.job.id);
    expect(second.snapshot.job.state).toBe("SUCCEEDED");
    expect(second.snapshot.case.state).toBe("VERIFIED");
    expect(executeTrustedSample).toHaveBeenCalledTimes(1);
  });

  it("rejects a changed command under an existing caller-scoped key", async () => {
    const { executeTrustedSample, service } = createHarness();

    await service.startTrustedReproduction({
      budget: { maxToolCalls: 6, requiredRuns: 3 },
      callerId: "chatgpt:anonymous",
      idempotencyKey: "tool-call-2",
      sampleId: "cli-spaces",
    });

    await expect(
      service.startTrustedReproduction({
        budget: { maxToolCalls: 7, requiredRuns: 3 },
        callerId: "chatgpt:anonymous",
        idempotencyKey: "tool-call-2",
        sampleId: "cli-spaces",
      }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect(executeTrustedSample).toHaveBeenCalledTimes(1);
  });

  it("scopes an idempotency key to the caller", async () => {
    const { executeTrustedSample, service } = createHarness();
    const shared = { idempotencyKey: "shared-key", sampleId: "cli-spaces" as const };

    const first = await service.startTrustedReproduction({
      ...shared,
      callerId: "caller-a",
    });
    const second = await service.startTrustedReproduction({
      ...shared,
      callerId: "caller-b",
    });

    expect(second.snapshot.case.id).not.toBe(first.snapshot.case.id);
    expect(executeTrustedSample).toHaveBeenCalledTimes(2);
  });

  it("reads and exports only the caller's completed reproduction", async () => {
    const { service } = createHarness();
    const started = await service.startTrustedReproduction({
      callerId: "web:demo",
      idempotencyKey: "web-demo-v1",
      sampleId: "cli-spaces",
    });

    const snapshot = await service.getReproduction({
      callerId: "web:demo",
      caseId: started.snapshot.case.id,
    });
    const exported = await service.exportReproBundle({
      callerId: "web:demo",
      caseId: snapshot.case.id,
    });

    expect(snapshot.schemaVersion).toBe("2.0");
    expect(exported.bundle.bundleHash).toBe(snapshot.result?.bundle?.bundleHash);
    expect(validateMaterializedBundle(exported.files)).toEqual({
      success: true,
      errors: [],
    });
    await expect(
      service.getReproduction({ callerId: "another-caller", caseId: snapshot.case.id }),
    ).rejects.toBeInstanceOf(ReproductionNotFoundError);
  });

  it("completes without an OpenAI API key", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const { service } = createHarness();

    const started = await service.startTrustedReproduction({
      callerId: "chatgpt:anonymous",
      idempotencyKey: "no-key",
      sampleId: "cli-spaces",
    });

    expect(started.snapshot.case.state).toBe("VERIFIED");
    expect(started.snapshot.result?.summary.status).toBe("VERIFIED");
  });

  it("reserves concurrent retries before trusted execution completes", async () => {
    let releaseExecution: (() => void) | undefined;
    const executionGate = new Promise<void>((resolve) => {
      releaseExecution = resolve;
    });
    let executions = 0;
    const service = new CaseService({
      clock: { now: () => new Date("2026-07-19T19:00:00.000Z") },
      executeTrustedSample: async (options) => {
        executions += 1;
        await executionGate;
        return runTrustedSample(options);
      },
      identifiers: {
        nextCaseId: () => "case-concurrent",
        nextJobId: () => "job-concurrent",
      },
      repository: new InMemoryReproductionRepository(),
    });
    const command = {
      callerId: "chatgpt:concurrent",
      idempotencyKey: "same-call",
      sampleId: "cli-spaces" as const,
    };

    const firstPromise = service.startTrustedReproduction(command);
    await vi.waitFor(() => expect(executions).toBe(1));
    const retry = await service.startTrustedReproduction(command);

    expect(retry.reused).toBe(true);
    expect(retry.snapshot.job.state).toBe("RUNNING");
    expect(executions).toBe(1);
    releaseExecution?.();
    await expect(firstPromise).resolves.toMatchObject({
      snapshot: { job: { state: "SUCCEEDED" } },
    });
  });

  it("persists only a sanitized failure when trusted execution throws", async () => {
    const service = new CaseService({
      clock: { now: () => new Date("2026-07-19T19:00:00.000Z") },
      executeTrustedSample: async () => {
        throw new Error("secret provider diagnostic");
      },
      identifiers: {
        nextCaseId: () => "case-failed",
        nextJobId: () => "job-failed",
      },
      repository: new InMemoryReproductionRepository(),
    });

    await expect(
      service.startTrustedReproduction({
        callerId: "chatgpt:failed",
        idempotencyKey: "failed-call",
        sampleId: "cli-spaces",
      }),
    ).rejects.toBeInstanceOf(TrustedExecutionFailedError);

    const snapshot = await service.getReproduction({
      callerId: "chatgpt:failed",
      caseId: "case-failed",
    });
    expect(snapshot.job).toMatchObject({
      failure: {
        code: "TRUSTED_EXECUTION_FAILED",
        message: "The trusted reproduction failed safely",
        retryable: true,
      },
      state: "FAILED",
    });
    expect(JSON.stringify(snapshot)).not.toContain("secret provider diagnostic");
  });
});
