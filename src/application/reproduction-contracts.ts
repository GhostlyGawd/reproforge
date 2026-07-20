import { z } from "zod";

import {
  sampleCaseResultSchema,
  trustedSampleBudgetSchema,
} from "./sample-case";
import { reproBundleSchema } from "@/domain/bundle";
import { reproCaseSchema } from "@/domain/case";
import { reproductionJobSchema } from "@/domain/job";
import { immutableRepositorySourceSchema } from "@/execution/contracts";
import { repositoryProofResultSchema } from "@/execution/repository-proof";

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
    repositorySource: immutableRepositorySourceSchema.optional(),
    result: z
      .union([sampleCaseResultSchema, repositoryProofResultSchema])
      .nullable(),
    sampleId: z.literal("cli-spaces").optional(),
    schemaVersion: z.literal("2.0"),
  })
  .strict()
  .superRefine((snapshot, context) => {
    const trusted = snapshot.sampleId !== undefined;
    const repository = snapshot.repositorySource !== undefined;
    if (trusted === repository) {
      context.addIssue({
        code: "custom",
        message: "snapshot requires exactly one trusted or repository source",
        path: ["sampleId"],
      });
    }
    const repositoryResult =
      snapshot.result !== null && "kind" in snapshot.result;
    if (
      (repositoryResult && !repository) ||
      (snapshot.result && !repositoryResult && !trusted)
    ) {
      context.addIssue({
        code: "custom",
        message: "result type must match the snapshot source",
        path: ["result"],
      });
    }
  });

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

