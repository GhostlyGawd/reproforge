import { z } from "zod";

import { evidenceItemSchema, hypothesisSchema } from "@/domain/evidence";

export const experimentRecipeSchema = z.enum(["control", "reproduce"]);

export const experimentProposalSchema = z
  .object({
    expectedSignal: z.string().min(1),
    hypothesisId: z.string().min(1),
    id: z.string().min(1),
    rationale: z.string().min(1),
    recipe: experimentRecipeSchema,
  })
  .strict();

export const investigationInputSchema = z
  .object({
    issue: z.string().min(1).max(10_000),
    maxToolCalls: z.number().int().min(1).max(12).default(6),
    repository: z.string().min(1).max(500),
  })
  .strict();

export const investigationPlanSchema = z
  .object({
    evidence: z.array(evidenceItemSchema).min(1),
    experiments: z.array(experimentProposalSchema).min(1),
    hypotheses: z.array(hypothesisSchema).min(1),
    mode: z.enum(["offline", "live"]),
    model: z.string().min(1),
    summary: z.string().min(1),
    toolCalls: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((plan, context) => {
    const evidenceIds = new Set(plan.evidence.map((item) => item.id));
    const hypothesisIds = new Set(plan.hypotheses.map((item) => item.id));

    plan.hypotheses.forEach((hypothesis, hypothesisIndex) => {
      hypothesis.evidenceIds.forEach((evidenceId, evidenceIndex) => {
        if (!evidenceIds.has(evidenceId)) {
          context.addIssue({
            code: "custom",
            message: `Unknown evidence reference: ${evidenceId}`,
            path: ["hypotheses", hypothesisIndex, "evidenceIds", evidenceIndex],
          });
        }
      });
    });

    plan.experiments.forEach((experiment, experimentIndex) => {
      if (!hypothesisIds.has(experiment.hypothesisId)) {
        context.addIssue({
          code: "custom",
          message: `Unknown hypothesis reference: ${experiment.hypothesisId}`,
          path: ["experiments", experimentIndex, "hypothesisId"],
        });
      }
    });
  });

export type ExperimentProposal = z.infer<typeof experimentProposalSchema>;
export type InvestigationInput = z.input<typeof investigationInputSchema>;
export type InvestigationPlan = z.infer<typeof investigationPlanSchema>;

export interface Investigator {
  investigate(input: InvestigationInput): Promise<InvestigationPlan>;
}
