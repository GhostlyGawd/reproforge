import { z } from "zod";

export const evidenceClassificationSchema = z.enum([
  "reported",
  "observed",
  "inferred",
  "unknown",
]);

export const evidenceItemSchema = z
  .object({
    classification: evidenceClassificationSchema,
    content: z.string().min(1),
    id: z.string().min(1),
    source: z.string().min(1),
  })
  .strict();

export type EvidenceItem = z.infer<typeof evidenceItemSchema>;

export const hypothesisStatusSchema = z.enum([
  "proposed",
  "supported",
  "contradicted",
  "inconclusive",
]);

export const hypothesisStatusHistoryEntrySchema = z
  .object({
    reason: z.string().min(1),
    sequence: z.number().int().nonnegative(),
    status: hypothesisStatusSchema,
  })
  .strict();

export const hypothesisSchema = z
  .object({
    evidenceIds: z.array(z.string().min(1)).min(1),
    expectedSignal: z.string().min(1),
    falsificationCondition: z.string().min(1),
    id: z.string().min(1),
    priority: z.number().int().min(1).max(5),
    statement: z.string().min(1),
    status: hypothesisStatusSchema,
    statusHistory: z.array(hypothesisStatusHistoryEntrySchema).min(1),
  })
  .strict()
  .superRefine((hypothesis, context) => {
    const latest = hypothesis.statusHistory.at(-1);
    if (latest?.status !== hypothesis.status) {
      context.addIssue({
        code: "custom",
        message: "Current status must match the latest history entry",
        path: ["status"],
      });
    }
    hypothesis.statusHistory.forEach((entry, index) => {
      if (index > 0 && entry.sequence <= hypothesis.statusHistory[index - 1]!.sequence) {
        context.addIssue({
          code: "custom",
          message: "Status history sequences must be strictly increasing",
          path: ["statusHistory", index, "sequence"],
        });
      }
    });
  });

export type Hypothesis = z.infer<typeof hypothesisSchema>;
