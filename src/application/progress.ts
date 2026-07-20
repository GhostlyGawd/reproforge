import { z } from "zod";

import { caseStateSchema } from "@/domain/case";
import {
  JOB_TERMINAL_STATES,
  jobFailureSchema,
  jobStateSchema,
  type ReproductionJob,
} from "@/domain/job";

export const progressViewSchema = z
  .object({
    attempt: z.number().int().nonnegative(),
    cancellable: z.boolean(),
    failure: jobFailureSchema.nullable(),
    phase: caseStateSchema,
    schemaVersion: z.literal("1.0"),
    state: jobStateSchema,
    terminal: z.boolean(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export type ProgressView = z.infer<typeof progressViewSchema>;

export function toReproductionProgress(job: ReproductionJob): ProgressView {
  const terminal = JOB_TERMINAL_STATES.includes(
    job.state as (typeof JOB_TERMINAL_STATES)[number],
  );
  return progressViewSchema.parse({
    attempt: job.attempt,
    cancellable: job.state === "QUEUED" || job.state === "RUNNING",
    failure: job.failure,
    phase: job.progressPhase,
    schemaVersion: "1.0",
    state: job.state,
    terminal,
    updatedAt: job.updatedAt,
  });
}
