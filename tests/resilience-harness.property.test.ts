import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  RESILIENCE_CATEGORIES,
  resilienceHarnessRegistrySchema,
} from "@/evaluation/resilience-harness";

describe("private-beta resilience harness properties", () => {
  it("rejects every generated registry missing or duplicating a required campaign", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...RESILIENCE_CATEGORIES), {
          maxLength: 12,
        }),
        (categories) => {
          const result = resilienceHarnessRegistrySchema.safeParse({
            schemaVersion: "1.0",
            scenarios: categories.map((category, index) => ({
              category,
              deterministicSeed: 8_406_000 + index,
              invariant:
                "A generated resilience invariant remains fail closed and deterministic.",
              testFiles: ["tests/generated.test.ts"],
            })),
          });
          const exact =
            categories.length === RESILIENCE_CATEGORIES.length &&
            new Set(categories).size === RESILIENCE_CATEGORIES.length;

          expect(result.success).toBe(exact);
        },
      ),
      { numRuns: 500, seed: 8_406_008 },
    );
  });
});
