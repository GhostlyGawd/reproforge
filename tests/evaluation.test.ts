import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { evaluateFixtureDirectory } from "@/evaluation/evaluate";

describe("evaluation suite", () => {
  it("classifies positive, negative, unstable, and misleading fixtures", async () => {
    const report = await evaluateFixtureDirectory(
      resolve(process.cwd(), "evals", "fixtures"),
    );

    expect(report).toMatchObject({
      accuracy: 1,
      bundleCompleteness: 1,
      failed: 0,
      falseNegatives: 0,
      falsePositives: 0,
      passed: 4,
      total: 4,
    });
    expect(report.statusDistribution).toEqual({
      BLOCKED: 1,
      NOT_REPRODUCED: 1,
      UNSTABLE: 1,
      VERIFIED: 1,
    });
    expect(report.cases.map((evaluation) => evaluation.id)).toEqual([
      "misleading-control",
      "negative-no-match",
      "positive-deterministic",
      "unstable-intermittent",
    ]);
  });
});
