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

export const hypothesisSchema = z
  .object({
    evidenceIds: z.array(z.string().min(1)),
    expectedSignal: z.string().min(1),
    falsificationCondition: z.string().min(1),
    id: z.string().min(1),
    statement: z.string().min(1),
    status: hypothesisStatusSchema,
  })
  .strict();

export type Hypothesis = z.infer<typeof hypothesisSchema>;

