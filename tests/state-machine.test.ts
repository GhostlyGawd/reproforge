import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  ACTIVE_CASE_STATES,
  CASE_STATES,
  TERMINAL_CASE_STATES,
  InvalidCaseTransitionError,
  createCase,
  transitionCase,
  type CaseState,
} from "@/domain/case";

describe("case state machine", () => {
  it("accepts the complete golden-path transition sequence", () => {
    const path: CaseState[] = [
      "INGESTING",
      "INSPECTING",
      "HYPOTHESIZING",
      "EXPERIMENTING",
      "VERIFYING",
      "MINIMIZING",
      "PACKAGING",
      "VERIFIED",
    ];

    const result = path.reduce(
      (current, next) => transitionCase(current, next, `entered ${next}`),
      createCase("case-golden"),
    );

    expect(result.state).toBe("VERIFIED");
    expect(result.history.map((entry) => entry.to)).toEqual(path);
  });

  it("rejects invalid transitions without mutating the input", () => {
    const original = createCase("case-invalid");
    const snapshot = structuredClone(original);

    expect(() => transitionCase(original, "VERIFIED", "skip proof")).toThrow(
      InvalidCaseTransitionError,
    );
    expect(original).toEqual(snapshot);
  });

  it("property: terminal states cannot re-enter active states", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...TERMINAL_CASE_STATES),
        fc.constantFrom(...ACTIVE_CASE_STATES),
        (terminal, active) => {
          const terminalCase = { ...createCase("terminal"), state: terminal };
          expect(() => transitionCase(terminalCase, active, "illegal")).toThrow(
            InvalidCaseTransitionError,
          );
        },
      ),
      { numRuns: 200 },
    );
  });

  it("property: every rejected transition preserves the original case", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...CASE_STATES),
        fc.constantFrom(...CASE_STATES),
        (from, to) => {
          const current = { ...createCase("preserved"), state: from };
          const snapshot = structuredClone(current);
          try {
            transitionCase(current, to, "candidate");
          } catch (error) {
            expect(error).toBeInstanceOf(InvalidCaseTransitionError);
            expect(current).toEqual(snapshot);
          }
        },
      ),
      { numRuns: 500 },
    );
  });
});

