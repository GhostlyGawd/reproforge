import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { OfflineInvestigator } from "@/ai/offline-investigator";

describe("offline investigator properties", () => {
  it("is deterministic and never exceeds the experiment budget", async () => {
    const investigator = new OfflineInvestigator();

    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 240 }),
        fc.integer({ min: 1, max: 4 }),
        async (issue, maxToolCalls) => {
          const input = {
            issue,
            maxToolCalls,
            repository: "fixture://cli-spaces",
          };
          const first = await investigator.investigate(input);
          const second = await investigator.investigate(input);

          expect(first).toEqual(second);
          expect(first.mode).toBe("offline");
          expect(first.experiments.length).toBeLessThanOrEqual(maxToolCalls);
          expect(first.evidence[0]?.content).toBe(issue);
        },
      ),
      { numRuns: 150 },
    );
  });
});
