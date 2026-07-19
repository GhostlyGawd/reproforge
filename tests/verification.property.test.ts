import { describe, expect, it } from "vitest";
import fc from "fast-check";

import type { RunResult } from "@/domain/run";
import { verifyReproduction } from "@/domain/verification";

const oracle = {
  id: "exit-one",
  version: 1,
  root: { type: "exit_code" as const, expected: 1 },
};

function run(id: string, matches: boolean): RunResult {
  return {
    id,
    command: "node repro.mjs",
    durationMs: 1,
    environmentHash: "property-env",
    exitCode: matches ? 1 : 0,
    stderr: "",
    stdout: "",
  };
}

describe("verification properties", () => {
  it("property: status agrees with candidate match counts", () => {
    fc.assert(
      fc.property(
        fc.array(fc.boolean(), { minLength: 3, maxLength: 20 }),
        (matches) => {
          const result = verifyReproduction({
            oracle,
            control: run("control", false),
            candidates: matches.map((matched, index) => run(String(index), matched)),
          });

          if (matches.every(Boolean)) {
            expect(result.status).toBe("VERIFIED");
          } else if (matches.some(Boolean)) {
            expect(result.status).toBe("UNSTABLE");
          } else {
            expect(result.status).toBe("NOT_REPRODUCED");
          }
          expect(result.repeatability).toBe(
            matches.filter(Boolean).length / matches.length,
          );
        },
      ),
      { numRuns: 300 },
    );
  });

  it("property: a matching control can never yield verified", () => {
    fc.assert(
      fc.property(
        fc.array(fc.boolean(), { minLength: 0, maxLength: 20 }),
        (matches) => {
          const result = verifyReproduction({
            oracle,
            control: run("control", true),
            candidates: matches.map((matched, index) => run(String(index), matched)),
          });
          expect(result.status).toBe("BLOCKED");
        },
      ),
      { numRuns: 300 },
    );
  });
});

