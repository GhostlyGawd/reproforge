import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  REQUIRED_BUNDLE_FILES,
  canonicalJson,
  createBundle,
  hashCanonical,
  materializeBundle,
  redactSecrets,
  validateMaterializedBundle,
} from "@/domain/bundle";
import type { VerificationSummary } from "@/domain/verification";

const summary: VerificationSummary = {
  candidateMatches: 3,
  controlMatched: false,
  oracleId: "oracle",
  oracleVersion: 1,
  reason: "verified",
  repeatability: 1,
  requiredRuns: 3,
  status: "VERIFIED",
  totalCandidateRuns: 3,
};

describe("Repro Bundle", () => {
  it("materializes every required file and validates independently", async () => {
    const bundle = await createBundle({
      caseId: "case-one",
      generatedAt: "2026-07-19T00:00:00.000Z",
      hypothesisLedger: [],
      lock: {
        command: "npm run repro",
        environmentHash: "env-one",
        packageManager: "npm@11",
        repository: "fixture://cli-spaces",
        revision: "fixture-v1",
        runner: "trusted-fixture-v1",
        runtime: "node@24",
      },
      oracle: { id: "oracle", version: 1, root: { type: "exit_code", expected: 1 } },
      reproductionPatch: "diff --git a/repro.mjs b/repro.mjs",
      runLog: [],
      summary,
    });
    const files = materializeBundle(bundle);
    expect(Object.keys(files).sort()).toEqual([...REQUIRED_BUNDLE_FILES].sort());
    expect(validateMaterializedBundle(files).success).toBe(true);
  });

  it("rejects a bundle whose verification is not successful", async () => {
    await expect(
      createBundle({
        caseId: "case-unverified",
        generatedAt: "2026-07-19T00:00:00.000Z",
        hypothesisLedger: [],
        lock: {
          command: "npm run repro",
          environmentHash: "env-one",
          packageManager: "npm@11",
          repository: "fixture://cli-spaces",
          revision: "fixture-v1",
          runner: "trusted-fixture-v1",
          runtime: "node@24",
        },
        oracle: { id: "oracle", version: 1, root: { type: "exit_code", expected: 1 } },
        reproductionPatch: "",
        runLog: [],
        summary: { ...summary, status: "UNSTABLE", repeatability: 2 / 3 },
      }),
    ).rejects.toThrow("verified");
  });

  it("rejects stale verification from a different oracle version", async () => {
    await expect(
      createBundle({
        caseId: "case-stale",
        generatedAt: "2026-07-19T00:00:00.000Z",
        hypothesisLedger: [],
        lock: {
          command: "npm run repro",
          environmentHash: "env-one",
          packageManager: "npm@11",
          repository: "fixture://cli-spaces",
          revision: "fixture-v1",
          runner: "trusted-fixture-v1",
          runtime: "node@24",
        },
        oracle: { id: "oracle", version: 2, root: { type: "exit_code", expected: 1 } },
        reproductionPatch: "",
        runLog: [],
        summary,
      }),
    ).rejects.toThrow("oracle version");
  });

  it("property: canonical JSON ignores object key insertion order", () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.jsonValue()), (record) => {
        const reversed = Object.fromEntries(Object.entries(record).reverse());
        expect(canonicalJson(record)).toBe(canonicalJson(reversed));
      }),
      { numRuns: 300 },
    );
  });

  it("property: redaction is idempotent and removes registered secrets", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }).filter((secret) => !secret.includes("[REDACTED]")),
        fc.string(),
        (secret, suffix) => {
          const value = { nested: [`prefix:${secret}:${suffix}`] };
          const once = redactSecrets(value, [secret]);
          const twice = redactSecrets(once, [secret]);
          expect(twice).toEqual(once);
          expect(once.nested[0].replaceAll("[REDACTED]", "")).not.toContain(secret);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("property: contract-relevant changes alter the canonical hash", () => {
    fc.assert(
      fc.asyncProperty(fc.string(), fc.string(), async (left, right) => {
        fc.pre(left !== right);
        expect(await hashCanonical({ value: left })).not.toBe(
          await hashCanonical({ value: right }),
        );
      }),
      { numRuns: 100 },
    );
  });
});
