import { z } from "zod";

import { failureOracleSchema } from "./oracle";
import { runResultSchema } from "./run";
import {
  verificationSummarySchema,
  verifyReproduction,
  type VerificationSummary,
} from "./verification";

export const minimizationProposalSchema = z
  .object({
    candidates: z.array(runResultSchema),
    control: runResultSchema,
    description: z.string().min(1),
    id: z.string().min(1),
    removedInputs: z
      .array(z.string().min(1))
      .min(1)
      .refine((values) => new Set(values).size === values.length, "Removed inputs must be unique"),
  })
  .strict();

export const minimizationEvaluationSchema = z
  .object({
    id: z.string().min(1),
    removedInputs: z.array(z.string().min(1)).min(1),
    summary: verificationSummarySchema,
  })
  .strict();

export const minimizationResultSchema = z
  .object({
    acceptedReductionId: z.string().min(1).nullable(),
    acceptedRemovedInputs: z.array(z.string().min(1)),
    claim: z.enum(["locally-minimized", "baseline-retained"]),
    evaluations: z.array(minimizationEvaluationSchema),
  })
  .strict()
  .superRefine((result, context) => {
    if (result.acceptedReductionId === null) {
      if (result.claim !== "baseline-retained" || result.acceptedRemovedInputs.length > 0) {
        context.addIssue({
          code: "custom",
          message: "A retained baseline cannot claim removed inputs",
          path: ["claim"],
        });
      }
      return;
    }

    const accepted = result.evaluations.find(
      (evaluation) => evaluation.id === result.acceptedReductionId,
    );
    if (!accepted || accepted.summary.status !== "VERIFIED") {
      context.addIssue({
        code: "custom",
        message: "An accepted reduction must have a verified evaluation",
        path: ["acceptedReductionId"],
      });
    }
    if (result.claim !== "locally-minimized") {
      context.addIssue({
        code: "custom",
        message: "An accepted reduction must use the locally-minimized claim",
        path: ["claim"],
      });
    }
  });

const minimizationInputSchema = z
  .object({
    baseline: z
      .object({
        candidates: z.array(runResultSchema),
        control: runResultSchema,
      })
      .strict(),
    oracle: failureOracleSchema,
    proposals: z.array(minimizationProposalSchema),
    requiredRuns: z.number().int().positive().default(3),
  })
  .strict();

export type MinimizationInput = z.input<typeof minimizationInputSchema>;
export type MinimizationResult = z.infer<typeof minimizationResultSchema>;

export function minimizeReproduction(rawInput: MinimizationInput): MinimizationResult {
  const input = minimizationInputSchema.parse(rawInput);
  const baselineSummary = verifyReproduction({
    ...input.baseline,
    oracle: input.oracle,
    requiredRuns: input.requiredRuns,
  });
  if (baselineSummary.status !== "VERIFIED") {
    throw new Error("Minimization requires a verified baseline reproduction");
  }

  const evaluations = input.proposals.map((proposal) => ({
    id: proposal.id,
    removedInputs: proposal.removedInputs,
    summary: verifyReproduction({
      candidates: proposal.candidates,
      control: proposal.control,
      oracle: input.oracle,
      requiredRuns: input.requiredRuns,
    }),
  }));
  const accepted = evaluations
    .filter(
      (evaluation): evaluation is typeof evaluation & { summary: VerificationSummary } =>
        evaluation.summary.status === "VERIFIED",
    )
    .sort(
      (left, right) =>
        right.removedInputs.length - left.removedInputs.length ||
        left.id.localeCompare(right.id),
    )[0];

  return minimizationResultSchema.parse({
    acceptedReductionId: accepted?.id ?? null,
    acceptedRemovedInputs: accepted?.removedInputs ?? [],
    claim: accepted ? "locally-minimized" : "baseline-retained",
    evaluations,
  });
}
