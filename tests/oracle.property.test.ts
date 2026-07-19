import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  evaluateOracle,
  type FailureOracle,
  type OracleExpression,
} from "@/domain/oracle";
import type { RunResult } from "@/domain/run";

const runArbitrary: fc.Arbitrary<RunResult> = fc.record({
  command: fc.string(),
  durationMs: fc.nat(),
  environmentHash: fc
    .array(fc.constantFrom(..."0123456789abcdef"), {
      minLength: 8,
      maxLength: 16,
    })
    .map((characters) => characters.join("")),
  exitCode: fc.integer({ min: -1, max: 255 }),
  id: fc.uuid(),
  stderr: fc.string(),
  stdout: fc.string(),
});

const leafArbitrary: fc.Arbitrary<OracleExpression> = fc.oneof(
  fc.integer({ min: -1, max: 255 }).map((expected) => ({
    type: "exit_code" as const,
    expected,
  })),
  fc
    .record({ stream: fc.constantFrom("stdout" as const, "stderr" as const), value: fc.string() })
    .map(({ stream, value }) => ({ type: "output_contains" as const, stream, value })),
);

describe("failure oracle", () => {
  it("property: evaluation is deterministic", () => {
    fc.assert(
      fc.property(leafArbitrary, runArbitrary, (root, run) => {
        const oracle: FailureOracle = { id: "oracle", version: 1, root };
        expect(evaluateOracle(oracle, run)).toEqual(evaluateOracle(oracle, run));
      }),
      { numRuns: 500 },
    );
  });

  it("property: double negation preserves the match result", () => {
    fc.assert(
      fc.property(leafArbitrary, runArbitrary, (leaf, run) => {
        const direct: FailureOracle = { id: "direct", version: 1, root: leaf };
        const doubleNot: FailureOracle = {
          id: "double-not",
          version: 1,
          root: { type: "not", child: { type: "not", child: leaf } },
        };
        expect(evaluateOracle(doubleNot, run).matched).toBe(
          evaluateOracle(direct, run).matched,
        );
      }),
      { numRuns: 500 },
    );
  });

  it("requires every child of an all expression", () => {
    const oracle: FailureOracle = {
      id: "cli-spaces",
      version: 1,
      root: {
        type: "all",
        children: [
          { type: "exit_code", expected: 1 },
          { type: "output_contains", stream: "stderr", value: "ENOENT" },
        ],
      },
    };
    const run: RunResult = {
      id: "run-1",
      command: "npm test",
      durationMs: 10,
      environmentHash: "env",
      exitCode: 1,
      stderr: "Error: ENOENT config path",
      stdout: "",
    };
    expect(evaluateOracle(oracle, run).matched).toBe(true);
    expect(evaluateOracle(oracle, { ...run, stderr: "different" }).matched).toBe(false);
  });
});
