import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { CaseService } from "@/application/case-service";
import { reproductionSnapshotSchema } from "@/application/reproduction-contracts";
import { canTransitionJob, JOB_TERMINAL_STATES } from "@/domain/job";
import { InMemoryReproductionRepository } from "@/infrastructure/reproduction-repository";

describe("case service properties", () => {
  it("executes at most once for every repeated caller and idempotency key", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 32 }),
        fc.string({ minLength: 1, maxLength: 32 }),
        async (callerId, idempotencyKey) => {
          let executions = 0;
          const service = new CaseService({
            clock: { now: () => new Date("2026-07-19T19:00:00.000Z") },
            executeTrustedSample: async (options) => {
              executions += 1;
              const { runTrustedSample } = await import("@/application/sample-case");
              return runTrustedSample(options);
            },
            identifiers: {
              nextCaseId: () => "case-property",
              nextJobId: () => "job-property",
            },
            repository: new InMemoryReproductionRepository(),
          });
          const command = { callerId, idempotencyKey, sampleId: "cli-spaces" as const };

          const first = await service.startTrustedReproduction(command);
          const second = await service.startTrustedReproduction(command);

          expect(executions).toBe(1);
          expect(second.snapshot.case.id).toBe(first.snapshot.case.id);
          expect(second.snapshot.job.id).toBe(first.snapshot.job.id);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("round-trips every completed trusted snapshot through JSON and its schema", async () => {
    const service = new CaseService({
      clock: { now: () => new Date("2026-07-19T19:00:00.000Z") },
      identifiers: {
        nextCaseId: () => "case-round-trip",
        nextJobId: () => "job-round-trip",
      },
      repository: new InMemoryReproductionRepository(),
    });
    const started = await service.startTrustedReproduction({
      callerId: "property-caller",
      idempotencyKey: "round-trip",
      sampleId: "cli-spaces",
    });

    const serialized = JSON.stringify(started.snapshot);
    expect(reproductionSnapshotSchema.parse(JSON.parse(serialized))).toEqual(
      started.snapshot,
    );
  });

  it("never permits a terminal job to return to any job state", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...JOB_TERMINAL_STATES),
        fc.constantFrom("QUEUED", "RUNNING", ...JOB_TERMINAL_STATES),
        (from, to) => {
          expect(canTransitionJob(from, to)).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("preserves the requested repeatability policy in every trusted proof", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 5 }), async (requiredRuns) => {
        const service = new CaseService({
          clock: { now: () => new Date("2026-07-19T19:00:00.000Z") },
          identifiers: {
            nextCaseId: () => `case-runs-${requiredRuns}`,
            nextJobId: () => `job-runs-${requiredRuns}`,
          },
          repository: new InMemoryReproductionRepository(),
        });
        const started = await service.startTrustedReproduction({
          budget: { maxToolCalls: 6, requiredRuns },
          callerId: "property-runs",
          idempotencyKey: `runs-${requiredRuns}`,
          sampleId: "cli-spaces",
        });

        expect(started.snapshot.result?.summary).toMatchObject({
          candidateMatches: requiredRuns,
          requiredRuns,
          status: "VERIFIED",
          totalCandidateRuns: requiredRuns,
        });
      }),
      { numRuns: 100 },
    );
  });
});
