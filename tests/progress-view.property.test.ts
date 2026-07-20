import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  progressViewSchema,
  toReproductionProgress,
} from "@/application/progress";
import {
  JOB_STATES,
  reproductionJobSchema,
  type JobState,
} from "@/domain/job";

const AT = "2026-07-20T12:00:00.000Z";

function job(state: JobState) {
  return reproductionJobSchema.parse({
    attempt: state === "QUEUED" || state === "CANCELLED" ? 0 : 1,
    caseId: "case_progress_property",
    createdAt: AT,
    failure:
      state === "FAILED"
        ? { code: "PROVIDER_FAILED", message: "Provider failed safely", retryable: true }
        : null,
    id: "job_progress_property",
    progressPhase:
      state === "SUCCEEDED"
        ? "VERIFIED"
        : state === "CANCELLED"
          ? "CANCELLED"
          : state === "FAILED"
            ? "BLOCKED"
            : "INGESTING",
    state,
    updatedAt: AT,
  });
}

describe("durable progress projection", () => {
  it("maps every job state to one stable cross-surface view over 500 schedules", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...JOB_STATES), { minLength: 1, maxLength: 30 }),
        (states) => {
          for (const state of states) {
            const progress = toReproductionProgress(job(state));
            expect(progressViewSchema.parse(progress)).toEqual(progress);
            expect(progress.terminal).toBe(
              state === "SUCCEEDED" || state === "FAILED" || state === "CANCELLED",
            );
            expect(progress.cancellable).toBe(
              state === "QUEUED" || state === "RUNNING",
            );
            expect(progress.failure).toEqual(
              state === "FAILED" ? job(state).failure : null,
            );
          }
        },
      ),
      { numRuns: 500 },
    );
  });

  it("does not expose mutable aliases or provider diagnostics", () => {
    const source = job("FAILED");
    const progress = toReproductionProgress(source);
    source.failure!.message = "mutated provider secret";

    expect(progress.failure?.message).toBe("Provider failed safely");
    expect(JSON.stringify(progress)).not.toContain("mutated provider secret");
  });
});
