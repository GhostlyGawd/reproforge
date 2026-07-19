import { describe, expect, it } from "vitest";

import { hypothesisSchema } from "@/domain/evidence";

const hypothesis = {
  evidenceIds: ["evidence-one"],
  expectedSignal: "The candidate fails.",
  falsificationCondition: "The candidate passes.",
  id: "hypothesis-one",
  priority: 1,
  statement: "The input triggers the failure.",
  status: "supported" as const,
  statusHistory: [
    { reason: "Recorded for testing.", sequence: 0, status: "proposed" as const },
    { reason: "Three candidate runs matched.", sequence: 1, status: "supported" as const },
  ],
};

describe("hypothesis ledger contract", () => {
  it("retains priority and ordered durable status history", () => {
    expect(hypothesisSchema.parse(hypothesis)).toEqual(hypothesis);
  });

  it("rejects a current status that disagrees with the latest history entry", () => {
    expect(() =>
      hypothesisSchema.parse({ ...hypothesis, status: "contradicted" }),
    ).toThrow("latest history");
  });

  it("rejects non-increasing history sequences", () => {
    expect(() =>
      hypothesisSchema.parse({
        ...hypothesis,
        statusHistory: [
          hypothesis.statusHistory[0],
          { ...hypothesis.statusHistory[1], sequence: 0 },
        ],
      }),
    ).toThrow("strictly increasing");
  });
});
