import { z } from "zod";

import type {
  ExportResult,
  ReproductionSnapshot,
} from "@/application/reproduction-contracts";
import { evidenceClassificationSchema, hypothesisStatusSchema } from "@/domain/evidence";

export const startReproductionInputSchema = z
  .object({
    budget: z
      .object({
        maxToolCalls: z
          .number()
          .int()
          .min(1)
          .max(20)
          .default(6)
          .describe("Maximum investigation tool calls for the trusted sample."),
        requiredRuns: z
          .number()
          .int()
          .min(1)
          .max(5)
          .default(3)
          .describe("Clean candidate runs required before verification."),
      })
      .strict()
      .optional(),
    idempotencyKey: z
      .string()
      .min(1)
      .max(128)
      .describe("Stable retry key for this same trusted-sample request."),
    sampleId: z
      .literal("cli-spaces")
      .default("cli-spaces")
      .describe("The only enabled input is ReproForge's trusted synthetic CLI fixture."),
  })
  .strict();

export const caseInputSchema = z
  .object({
    caseId: z.string().min(1).max(128).describe("Case ID returned by start_reproduction."),
  })
  .strict();

export const evidenceCountsSchema = z
  .object({
    inferred: z.number().int().nonnegative(),
    observed: z.number().int().nonnegative(),
    reported: z.number().int().nonnegative(),
    unknown: z.number().int().nonnegative(),
  })
  .strict();

export const proofViewSchema = z
  .object({
    bundleHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    bundleReady: z.boolean(),
    candidateMatches: z.number().int().nonnegative(),
    controlMatched: z.boolean(),
    oracleId: z.string().min(1).nullable(),
    oracleVersion: z.number().int().positive().nullable(),
    repeatability: z.number().min(0).max(1),
    requiredRuns: z.number().int().positive(),
    status: z
      .enum(["VERIFIED", "UNSTABLE", "NOT_REPRODUCED", "BLOCKED"])
      .nullable(),
  })
  .strict();

export const hypothesisViewSchema = z
  .object({
    id: z.string().min(1),
    priority: z.number().int().min(1).max(5),
    statement: z.string().min(1),
    status: hypothesisStatusSchema,
  })
  .strict();

export const runViewSchema = z
  .object({
    exitCode: z.number().int(),
    id: z.string().min(1),
    role: z.enum(["control", "candidate"]),
  })
  .strict();

export const reproductionViewSchema = z
  .object({
    caseId: z.string().min(1),
    caseState: z.string().min(1),
    evidenceCounts: evidenceCountsSchema,
    hypotheses: z.array(hypothesisViewSchema),
    jobId: z.string().min(1),
    jobState: z.string().min(1),
    kind: z.literal("reproduction"),
    proof: proofViewSchema,
    runs: z.array(runViewSchema),
    sampleId: z.literal("cli-spaces"),
    schemaVersion: z.literal("1.0"),
  })
  .strict();

export const bundleViewSchema = z
  .object({
    bundleHash: z.string().regex(/^[a-f0-9]{64}$/),
    bundleSchemaVersion: z.literal("1.1"),
    caseId: z.string().min(1),
    fileNames: z.array(z.string().min(1)),
    kind: z.literal("bundle"),
    schemaVersion: z.literal("1.0"),
    status: z.literal("VERIFIED"),
  })
  .strict();

const evidenceViewSchema = z
  .object({
    classification: evidenceClassificationSchema,
    content: z.string().min(1),
    id: z.string().min(1),
    source: z.string().min(1),
  })
  .strict();

export const reproductionWidgetMetaSchema = z
  .object({
    bundleFileNames: z.array(z.string().min(1)),
    command: z.string().min(1).nullable(),
    evidence: z.array(evidenceViewSchema),
    reason: z.string().min(1).nullable(),
    reused: z.boolean(),
  })
  .strict();

export type ReproductionView = z.infer<typeof reproductionViewSchema>;
export type BundleView = z.infer<typeof bundleViewSchema>;
export type ReproductionWidgetMeta = z.infer<typeof reproductionWidgetMetaSchema>;

function countEvidence(snapshot: ReproductionSnapshot) {
  const counts = { inferred: 0, observed: 0, reported: 0, unknown: 0 };
  snapshot.result?.evidence.forEach((item) => {
    counts[item.classification] += 1;
  });
  return counts;
}

export function toReproductionView(snapshot: ReproductionSnapshot): ReproductionView {
  const result = snapshot.result;
  const summary = result?.summary;
  return reproductionViewSchema.parse({
    caseId: snapshot.case.id,
    caseState: snapshot.case.state,
    evidenceCounts: countEvidence(snapshot),
    hypotheses:
      result?.hypotheses.map(({ id, priority, statement, status }) => ({
        id,
        priority,
        statement,
        status,
      })) ?? [],
    jobId: snapshot.job.id,
    jobState: snapshot.job.state,
    kind: "reproduction",
    proof: {
      bundleHash: result?.bundle.bundleHash ?? null,
      bundleReady: result?.summary.status === "VERIFIED",
      candidateMatches: summary?.candidateMatches ?? 0,
      controlMatched: summary?.controlMatched ?? false,
      oracleId: summary?.oracleId ?? null,
      oracleVersion: summary?.oracleVersion ?? null,
      repeatability: summary?.repeatability ?? 0,
      requiredRuns: summary?.requiredRuns ?? result?.budget.requiredRuns ?? 3,
      status: summary?.status ?? null,
    },
    runs:
      result?.runs.map((run) => ({
        exitCode: run.exitCode,
        id: run.id,
        role: run.id.includes("control") ? "control" : "candidate",
      })) ?? [],
    sampleId: snapshot.sampleId,
    schemaVersion: "1.0",
  });
}

export function toReproductionWidgetMeta(
  snapshot: ReproductionSnapshot,
  reused = false,
): ReproductionWidgetMeta {
  return reproductionWidgetMetaSchema.parse({
    bundleFileNames: Object.keys(snapshot.result?.files ?? {}).sort(),
    command: snapshot.result?.bundle.lock.command ?? null,
    evidence: snapshot.result?.evidence ?? [],
    reason: snapshot.result?.summary.reason ?? snapshot.job.failure?.message ?? null,
    reused,
  });
}

export function toBundleView(exported: ExportResult): BundleView {
  return bundleViewSchema.parse({
    bundleHash: exported.bundle.bundleHash,
    bundleSchemaVersion: exported.bundle.schemaVersion,
    caseId: exported.caseId,
    fileNames: Object.keys(exported.files).sort(),
    kind: "bundle",
    schemaVersion: "1.0",
    status: exported.bundle.summary.status,
  });
}
