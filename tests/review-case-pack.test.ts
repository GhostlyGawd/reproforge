import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  parseReviewCasePack,
  reviewCaseObservationSchema,
  verifyReviewCaseObservation,
} from "@/review/case-pack";

async function loadPackInput(): Promise<unknown> {
  return JSON.parse(
    await readFile(
      resolve(process.cwd(), "docs", "submission", "review-cases.json"),
      "utf8",
    ),
  );
}

describe("submission review case pack", () => {
  it("contains exactly the required five positive and three negative cases", async () => {
    const pack = parseReviewCasePack(await loadPackInput());

    expect(pack.cases).toHaveLength(8);
    expect(pack.cases.filter(({ polarity }) => polarity === "positive")).toHaveLength(5);
    expect(pack.cases.filter(({ polarity }) => polarity === "negative")).toHaveLength(3);
    expect(pack.cases.map(({ id }) => id)).toEqual([
      "positive-trusted-demo",
      "positive-authorized-list",
      "positive-public-canary",
      "positive-private-canary",
      "positive-intermittent-canary",
      "negative-arbitrary-execution",
      "negative-cross-tenant-read",
      "negative-destructive-or-fabricated",
    ]);
  });

  it("records an executable sequence, fixture boundary, expected shape, and evidence state", async () => {
    const pack = parseReviewCasePack(await loadPackInput());

    for (const reviewCase of pack.cases) {
      expect(reviewCase.prompt.length).toBeGreaterThan(20);
      expect(reviewCase.prerequisites.length).toBeGreaterThan(0);
      expect(reviewCase.expectedResult.assertions.length).toBeGreaterThan(0);
      expect(reviewCase.fixture.dataClassification).toBe("synthetic");
      expect(reviewCase.passEvidence.status).toBe("pending_hosted");
    }

    expect(pack.cases[0]?.expectedToolSequence).toEqual([
      "start_reproduction",
      "get_reproduction",
      "export_repro_bundle",
    ]);
    expect(pack.cases[4]?.expectedResult).toMatchObject({
      bundle: "forbidden",
      outcome: "UNSTABLE",
    });
    expect(pack.cases[5]?.expectedToolSequence).toEqual([]);
    expect(pack.cases[7]?.expectedToolSequence).toEqual([]);
  });

  it("keeps private identities and credentials out of committed fixtures", async () => {
    const pack = parseReviewCasePack(await loadPackInput());
    const serialized = JSON.stringify(pack);
    const privateCase = pack.cases.find(({ id }) => id === "positive-private-canary");

    expect(privateCase?.fixture).toMatchObject({
      alias: "authorized-private-canary",
      visibility: "private",
    });
    expect(privateCase?.fixture.environment).toEqual([
      "REPROFORGE_REVIEW_PRIVATE_REPOSITORY_ID",
      "REPROFORGE_REVIEW_PRIVATE_COMMIT_SHA",
    ]);
    expect(serialized).not.toMatch(
      /github_pat_|ghp_|bearer\s+[a-z0-9._-]+|api[_-]?key|client[_-]?secret|private[_-]?key/i,
    );
  });

  it("rejects every count mutation instead of silently changing the portal contract", async () => {
    const input = (await loadPackInput()) as { cases: unknown[] };

    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: input.cases.length - 1 }),
        async (index) => {
          const removed = structuredClone(input);
          removed.cases.splice(index, 1);
          expect(() => parseReviewCasePack(removed)).toThrow();

          const duplicated = structuredClone(input);
          duplicated.cases.push(structuredClone(input.cases[index]));
          expect(() => parseReviewCasePack(duplicated)).toThrow();
        },
      ),
      { numRuns: 40 },
    );
  });

  it("accepts matching observations and fails closed on outcome, bundle, or disclosure drift", async () => {
    const pack = parseReviewCasePack(await loadPackInput());

    for (const reviewCase of pack.cases) {
      const observation = reviewCaseObservationSchema.parse({
        assertions: reviewCase.expectedResult.assertions,
        bundle: reviewCase.expectedResult.bundle,
        caseId: reviewCase.id,
        narration: "Synthetic reviewer-safe result with no repository identity or credential.",
        outcome: reviewCase.expectedResult.outcome,
        toolSequence: reviewCase.expectedToolSequence,
      });
      expect(verifyReviewCaseObservation(reviewCase, observation)).toEqual({
        failures: [],
        passed: true,
      });

      expect(
        verifyReviewCaseObservation(reviewCase, {
          ...observation,
          bundle: reviewCase.expectedResult.bundle === "required" ? "forbidden" : "required",
        }),
      ).toMatchObject({ passed: false });
    }
  });
});
