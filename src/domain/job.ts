import { z } from "zod";

import { caseStateSchema, type CaseState } from "./case";

export const JOB_STATES = [
  "QUEUED",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
] as const;

export const JOB_TERMINAL_STATES = ["SUCCEEDED", "FAILED", "CANCELLED"] as const;

export const jobStateSchema = z.enum(JOB_STATES);
export type JobState = z.infer<typeof jobStateSchema>;

export const jobFailureSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
    retryable: z.boolean(),
  })
  .strict();

export const reproductionJobSchema = z
  .object({
    attempt: z.number().int().nonnegative().max(100),
    caseId: z.string().min(1),
    createdAt: z.string().datetime(),
    failure: jobFailureSchema.nullable(),
    id: z.string().min(1),
    progressPhase: caseStateSchema,
    state: jobStateSchema,
    updatedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((job, context) => {
    if (job.state !== "QUEUED" && job.attempt < 1) {
      context.addIssue({
        code: "custom",
        message: "An active or terminal job requires an attempt",
        path: ["attempt"],
      });
    }
    if (job.state === "FAILED" && job.failure === null) {
      context.addIssue({
        code: "custom",
        message: "A failed job requires a sanitized failure",
        path: ["failure"],
      });
    }
    if (job.state !== "FAILED" && job.failure !== null) {
      context.addIssue({
        code: "custom",
        message: "Only a failed job can include failure details",
        path: ["failure"],
      });
    }
  });

export type ReproductionJob = z.infer<typeof reproductionJobSchema>;

const allowedTransitions: Readonly<Record<JobState, readonly JobState[]>> = {
  QUEUED: ["RUNNING", "CANCELLED"],
  RUNNING: ["SUCCEEDED", "FAILED", "CANCELLED"],
  SUCCEEDED: [],
  FAILED: [],
  CANCELLED: [],
};

export class InvalidJobTransitionError extends Error {
  constructor(from: JobState, to: JobState) {
    super(`Invalid ReproForge job transition: ${from} -> ${to}`);
    this.name = "InvalidJobTransitionError";
  }
}

export function createJob(
  id: string,
  caseId: string,
  at = new Date(),
): ReproductionJob {
  const timestamp = at.toISOString();
  return reproductionJobSchema.parse({
    attempt: 0,
    caseId,
    createdAt: timestamp,
    failure: null,
    id,
    progressPhase: "DRAFT",
    state: "QUEUED",
    updatedAt: timestamp,
  });
}

export function canTransitionJob(from: JobState, to: JobState): boolean {
  return allowedTransitions[from].includes(to);
}

export function transitionJob(
  current: ReproductionJob,
  to: JobState,
  options: {
    at?: Date;
    failure?: z.infer<typeof jobFailureSchema>;
    progressPhase: CaseState;
  },
): ReproductionJob {
  if (!canTransitionJob(current.state, to)) {
    throw new InvalidJobTransitionError(current.state, to);
  }

  return reproductionJobSchema.parse({
    ...current,
    attempt:
      current.state === "QUEUED" && to === "RUNNING"
        ? current.attempt + 1
        : current.attempt,
    failure: options.failure ?? null,
    progressPhase: options.progressPhase,
    state: to,
    updatedAt: (options.at ?? new Date()).toISOString(),
  });
}

