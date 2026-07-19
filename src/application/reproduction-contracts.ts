import { z } from "zod";

import {
  sampleCaseResultSchema,
  trustedSampleBudgetSchema,
} from "./sample-case";
import { reproBundleSchema } from "@/domain/bundle";
import { reproCaseSchema } from "@/domain/case";
import { reproductionJobSchema } from "@/domain/job";

export const startTrustedReproductionSchema = z
  .object({
    budget: trustedSampleBudgetSchema.default({
      maxToolCalls: 6,
      requiredRuns: 3,
    }),
    callerId: z.string().min(1).max(128),
    idempotencyKey: z.string().min(1).max(128),
    sampleId: z.literal("cli-spaces"),
  })
  .strict();

export const getReproductionSchema = z
  .object({
    callerId: z.string().min(1).max(128),
    caseId: z.string().min(1).max(128),
  })
  .strict();

export const getJobSchema = z
  .object({
    callerId: z.string().min(1).max(128),
    jobId: z.string().min(1).max(128),
  })
  .strict();

export const reproductionSnapshotSchema = z
  .object({
    case: reproCaseSchema,
    job: reproductionJobSchema,
    result: sampleCaseResultSchema.nullable(),
    sampleId: z.literal("cli-spaces"),
    schemaVersion: z.literal("2.0"),
  })
  .strict();

export const startResultSchema = z
  .object({
    reused: z.boolean(),
    snapshot: reproductionSnapshotSchema,
  })
  .strict();

export const jobSnapshotSchema = z
  .object({
    job: reproductionJobSchema,
    schemaVersion: z.literal("2.0"),
  })
  .strict();

export const exportResultSchema = z
  .object({
    bundle: reproBundleSchema,
    caseId: z.string().min(1),
    files: z.record(z.string(), z.string()),
    schemaVersion: z.literal("2.0"),
  })
  .strict();

export type StartTrustedReproduction = z.input<
  typeof startTrustedReproductionSchema
>;
export type GetReproduction = z.input<typeof getReproductionSchema>;
export type GetJob = z.input<typeof getJobSchema>;
export type ReproductionSnapshot = z.infer<typeof reproductionSnapshotSchema>;
export type StartResult = z.infer<typeof startResultSchema>;
export type JobSnapshot = z.infer<typeof jobSnapshotSchema>;
export type ExportResult = z.infer<typeof exportResultSchema>;

