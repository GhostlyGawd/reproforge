import { describe, expect, it, vi } from "vitest";

import { CaseService } from "@/application/case-service";
import { runTrustedSample } from "@/application/sample-case";
import { InMemoryReproductionRepository } from "@/infrastructure/reproduction-repository";

describe("deterministic private-beta load harness", () => {
  it("collapses a 128-request idempotent burst into one execution and identity", async () => {
    let releaseExecution: (() => void) | undefined;
    const executionGate = new Promise<void>((resolve) => {
      releaseExecution = resolve;
    });
    let executions = 0;
    let caseSequence = 0;
    let jobSequence = 0;
    const repository = new InMemoryReproductionRepository();
    const service = new CaseService({
      clock: { now: () => new Date("2026-07-20T23:30:00.000Z") },
      executeTrustedSample: async (options) => {
        executions += 1;
        await executionGate;
        return runTrustedSample(options);
      },
      identifiers: {
        nextCaseId: () => `case_load_${++caseSequence}`,
        nextJobId: () => `job_load_${++jobSequence}`,
      },
      repository,
    });
    const command = {
      callerId: "load:synthetic",
      idempotencyKey: "load-burst-8406001",
      sampleId: "cli-spaces" as const,
    };

    const first = service.startTrustedReproduction(command);
    await vi.waitFor(() => expect(executions).toBe(1));
    const retries = await Promise.all(
      Array.from({ length: 127 }, () =>
        service.startTrustedReproduction(command),
      ),
    );

    expect(retries).toHaveLength(127);
    expect(retries.every(({ reused }) => reused)).toBe(true);
    expect(new Set(retries.map(({ snapshot }) => snapshot.case.id))).toEqual(
      new Set(["case_load_1"]),
    );
    expect(new Set(retries.map(({ snapshot }) => snapshot.job.id))).toEqual(
      new Set(["job_load_1"]),
    );
    expect(retries.every(({ snapshot }) => snapshot.job.state === "RUNNING"))
      .toBe(true);
    expect(executions).toBe(1);

    releaseExecution?.();
    const completed = await first;
    expect(completed.snapshot).toMatchObject({
      case: { id: "case_load_1", state: "VERIFIED" },
      job: { id: "job_load_1", state: "SUCCEEDED" },
      result: { summary: { status: "VERIFIED" } },
    });

    const reads = await Promise.all(
      Array.from({ length: 128 }, () =>
        service.getReproduction({
          callerId: command.callerId,
          caseId: completed.snapshot.case.id,
        }),
      ),
    );
    expect(reads.every(({ case: value }) => value.id === "case_load_1"))
      .toBe(true);
    expect(
      new Set(reads.map(({ result }) => result?.bundle?.bundleHash)).size,
    ).toBe(1);
    expect(executions).toBe(1);
  });
});
