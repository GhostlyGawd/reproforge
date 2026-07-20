import { z } from "zod";

import type {
  ExportResult,
  ReproductionSnapshot,
} from "@/application/reproduction-contracts";
import { evidenceClassificationSchema, hypothesisStatusSchema } from "@/domain/evidence";

const trustedSourceSchema = z
  .object({
    kind: z.literal("trusted_sample"),
    sampleId: z.literal("cli-spaces"),
  })
  .strict();

export const repositorySourceSchema = z
  .object({
    commitSha: z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .describe("Immutable 40-character Git commit SHA selected from GitHub."),
    executionProfile: z
      .object({
        ecosystem: z.literal("node"),
        networkPolicy: z.literal("none"),
        packageManager: z.literal("npm"),
        testEntrypoint: z.literal("npm-test"),
      })
      .strict(),
    issueEvidence: z
      .object({
        number: z.number().int().positive().max(2_147_483_647),
        title: z.string().min(1).max(256).optional(),
      })
      .strict()
      .optional(),
    kind: z.literal("github"),
    repositoryId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
      .describe("Server-issued identifier from list_authorized_repositories."),
  })
  .strict();

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
          .describe("Maximum bounded investigation tool calls."),
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
    source: z.discriminatedUnion("kind", [
      trustedSourceSchema,
      repositorySourceSchema,
    ]),
  })
  .strict();

export const caseInputSchema = z
  .object({
    caseId: z.string().min(1).max(128).describe("Case ID returned by start_reproduction."),
  })
  .strict();

export const cancelReproductionInputSchema = z
  .object({
    jobId: z.string().min(1).max(128),
  })
  .strict();

export const listAuthorizedRepositoriesInputSchema = z
  .object({
    cursor: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
    limit: z.number().int().min(1).max(100).default(50).optional(),
  })
  .strict();

export const repositoryViewSchema = z
  .object({
    defaultBranch: z.string().min(1).max(255),
    fullName: z
      .string()
      .min(3)
      .max(255)
      .regex(/^[^/\s]+\/[^/\s]+$/),
    private: z.boolean(),
    repositoryId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  })
  .strict();

export const repositoryListViewSchema = z
  .object({
    kind: z.literal("repository_list"),
    nextCursor: z.string().min(1).max(256).nullable(),
    repositories: z.array(repositoryViewSchema).max(100),
    schemaVersion: z.literal("1.0"),
  })
  .strict();

export const cancellationViewSchema = z
  .object({
    caseId: z.string().min(1).max(128),
    changed: z.boolean(),
    disposition: z.enum(["cancelled", "requested"]),
    kind: z.literal("cancellation"),
    schemaVersion: z.literal("1.0"),
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
    repository: z
      .object({
        commitSha: z.string().regex(/^[a-f0-9]{40}$/),
        fullName: z.string().min(3).max(255),
        private: z.boolean(),
        repositoryId: z.string().min(1).max(128),
      })
      .strict()
      .optional(),
    sampleId: z.literal("cli-spaces").optional(),
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
export type RepositoryListView = z.infer<typeof repositoryListViewSchema>;

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
      bundleHash: result?.bundle?.bundleHash ?? null,
      bundleReady:
        result?.summary.status === "VERIFIED" && result.bundle !== null,
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
    ...(snapshot.repositorySource
      ? { repository: snapshot.repositorySource }
      : {}),
    ...(snapshot.sampleId ? { sampleId: snapshot.sampleId } : {}),
    schemaVersion: "1.0",
  });
}

export function toReproductionWidgetMeta(
  snapshot: ReproductionSnapshot,
  reused = false,
): ReproductionWidgetMeta {
  return reproductionWidgetMetaSchema.parse({
    bundleFileNames: Object.keys(snapshot.result?.files ?? {}).sort(),
    command: snapshot.result?.bundle?.lock.command ?? null,
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
