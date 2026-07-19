import { z } from "zod";

import { failureOracleSchema } from "@/domain/oracle";
import { runResultSchema } from "@/domain/run";
import { verificationStatusSchema } from "@/domain/verification";

export const evaluationFixtureSchema = z
  .object({
    candidates: z.array(runResultSchema),
    category: z.enum(["positive", "negative", "unstable", "misleading"]),
    control: runResultSchema,
    description: z.string().min(1),
    expectedStatus: verificationStatusSchema,
    id: z.string().regex(/^[a-z0-9-]+$/),
    oracle: failureOracleSchema,
    schemaVersion: z.literal("1.0"),
  })
  .strict();

export type EvaluationFixture = z.infer<typeof evaluationFixtureSchema>;
