import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { minimizeReproduction } from "@/domain/minimization";
import type { RunResult } from "@/domain/run";

function run(id: string, exitCode: number): RunResult {
  return {
    command: id,
    durationMs: 1,
    environmentHash: "minimizer-env",
    exitCode,
    id,
    stderr: exitCode === 1 ? "ENOENT" : "",
    stdout: "",
  };
}

const oracle = {
  id: "minimizer-oracle",
  root: { type: "exit_code" as const, expected: 1 },
  version: 1,
};

const baseline = {
  candidates: [run("baseline-1", 1), run("baseline-2", 1), run("baseline-3", 1)],
  control: run("baseline-control", 0),
};

describe("reproduction minimizer", () => {
  it("rejects a reduction whose negative control matches the failure", () => {
    const result = minimizeReproduction({
      baseline,
      oracle,
      proposals: [
        {
          candidates: [run("bad-1", 1), run("bad-2", 1), run("bad-3", 1)],
          control: run("bad-control", 1),
          description: "Over-reduced candidate",
          id: "bad-reduction",
          removedInputs: ["control distinction"],
        },
      ],
    });

    expect(result.acceptedReductionId).toBeNull();
    expect(result.claim).toBe("baseline-retained");
    expect(result.evaluations[0]?.summary.status).toBe("BLOCKED");
  });

  it("property: every accepted reduction remains independently verified", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            candidateCodes: fc.tuple(
              fc.constantFrom(0, 1),
              fc.constantFrom(0, 1),
              fc.constantFrom(0, 1),
            ),
            controlCode: fc.constantFrom(0, 1),
            removedCount: fc.integer({ min: 1, max: 5 }),
          }),
          { minLength: 1, maxLength: 8 },
        ),
        (generated) => {
          const result = minimizeReproduction({
            baseline,
            oracle,
            proposals: generated.map((item, proposalIndex) => ({
              candidates: item.candidateCodes.map((code, runIndex) =>
                run(`proposal-${proposalIndex}-run-${runIndex}`, code),
              ),
              control: run(`proposal-${proposalIndex}-control`, item.controlCode),
              description: `Generated reduction ${proposalIndex}`,
              id: `proposal-${proposalIndex}`,
              removedInputs: Array.from(
                { length: item.removedCount },
                (_, inputIndex) => `input-${inputIndex}`,
              ),
            })),
          });

          if (result.acceptedReductionId !== null) {
            const accepted = result.evaluations.find(
              (evaluation) => evaluation.id === result.acceptedReductionId,
            );
            expect(accepted?.summary.status).toBe("VERIFIED");
            expect(accepted?.summary.controlMatched).toBe(false);
          }
        },
      ),
      { numRuns: 250 },
    );
  });
});
