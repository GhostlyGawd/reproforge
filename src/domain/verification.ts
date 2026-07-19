import { z } from "zod";

import { evaluateOracle, failureOracleSchema } from "./oracle";
import { runResultSchema, type RunResult } from "./run";

export const verificationStatusSchema = z.enum([
  "VERIFIED",
  "UNSTABLE",
  "NOT_REPRODUCED",
  "BLOCKED",
]);

export const verificationSummarySchema = z
  .object({
    candidateMatches: z.number().int().nonnegative(),
    controlMatched: z.boolean(),
    oracleId: z.string().min(1),
    oracleVersion: z.number().int().positive(),
    reason: z.string().min(1),
    repeatability: z.number().min(0).max(1),
    requiredRuns: z.number().int().positive(),
    status: verificationStatusSchema,
    totalCandidateRuns: z.number().int().nonnegative(),
  })
  .strict();

export type VerificationSummary = z.infer<typeof verificationSummarySchema>;

export const verificationInputSchema = z
  .object({
    oracle: failureOracleSchema,
    control: runResultSchema,
    candidates: z.array(runResultSchema),
    requiredRuns: z.number().int().positive().default(3),
  })
  .strict();

export type VerificationInput = z.input<typeof verificationInputSchema>;

export function verifyReproduction(input: VerificationInput): VerificationSummary {
  const parsed = verificationInputSchema.parse(input);
  const controlMatched = evaluateOracle(parsed.oracle, parsed.control).matched;
  const candidateMatches = parsed.candidates.filter(
    (run) => evaluateOracle(parsed.oracle, run).matched,
  ).length;
  const totalCandidateRuns = parsed.candidates.length;
  const repeatability =
    totalCandidateRuns === 0 ? 0 : candidateMatches / totalCandidateRuns;

  const environmentHashes = new Set([
    parsed.control.environmentHash,
    ...parsed.candidates.map((run: RunResult) => run.environmentHash),
  ]);

  let status: VerificationSummary["status"];
  let reason: string;

  if (controlMatched) {
    status = "BLOCKED";
    reason = "The failure oracle also matched the negative control.";
  } else if (environmentHashes.size !== 1) {
    status = "BLOCKED";
    reason = "Verification runs did not use one pinned environment.";
  } else if (
    totalCandidateRuns >= parsed.requiredRuns &&
    candidateMatches === totalCandidateRuns
  ) {
    status = "VERIFIED";
    reason = `The oracle matched all ${totalCandidateRuns} clean candidate runs and did not match the control.`;
  } else if (candidateMatches > 0) {
    status = "UNSTABLE";
    reason = `The oracle matched ${candidateMatches} of ${totalCandidateRuns} candidate runs.`;
  } else {
    status = "NOT_REPRODUCED";
    reason = `The oracle matched none of ${totalCandidateRuns} candidate runs.`;
  }

  return verificationSummarySchema.parse({
    candidateMatches,
    controlMatched,
    oracleId: parsed.oracle.id,
    oracleVersion: parsed.oracle.version,
    reason,
    repeatability,
    requiredRuns: parsed.requiredRuns,
    status,
    totalCandidateRuns,
  });
}
