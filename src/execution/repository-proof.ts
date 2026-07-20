import { z } from "zod";

import {
  createBundle,
  materializeBundle,
  redactSecrets,
  reproBundleSchema,
  validateMaterializedBundle,
} from "@/domain/bundle";
import {
  reproCaseSchema,
  transitionCase,
  type CaseState,
  type ReproCase,
} from "@/domain/case";
import {
  evidenceItemSchema,
  hypothesisSchema,
  type EvidenceItem,
  type Hypothesis,
} from "@/domain/evidence";
import {
  minimizationResultSchema,
  minimizeReproduction,
} from "@/domain/minimization";
import { failureOracleSchema } from "@/domain/oracle";
import { runResultSchema, type RunResult } from "@/domain/run";
import {
  verificationSummarySchema,
  verifyReproduction,
  type VerificationSummary,
} from "@/domain/verification";
import {
  boundedExperimentResultSchema,
  type BoundedRun,
} from "@/execution/bounded-execution";
import {
  immutableRepositorySourceSchema,
  nodeRepositoryProfileSchema,
} from "@/execution/contracts";
import { dependencyMetadataSchema } from "@/execution/dependency-preparation";
import { executionEnvironmentProvenanceSchema } from "@/execution/execution-planning";
import { sourceProvenanceSchema } from "@/execution/source-provenance";

const repositoryBudgetSchema = z
  .object({
    maxToolCalls: z.number().int().min(1).max(12),
    requiredRuns: z.number().int().min(3).max(5),
  })
  .strict();

const issueEvidenceSchema = z
  .object({
    number: z.number().int().positive().max(2_147_483_647),
    title: z.string().min(1).max(256).optional(),
  })
  .strict();

const repositoryProofInputSchema = z
  .object({
    budget: repositoryBudgetSchema,
    case: reproCaseSchema.refine((value) => value.state === "DRAFT"),
    cleanupStatus: z.enum(["clean", "quarantined"]),
    dependency: dependencyMetadataSchema,
    environment: executionEnvironmentProvenanceSchema,
    execution: boundedExperimentResultSchema,
    generatedAt: z.string().datetime(),
    issueEvidence: issueEvidenceSchema.optional(),
    oracle: failureOracleSchema,
    profile: nodeRepositoryProfileSchema,
    secrets: z.array(z.string().min(1).max(4_096)).max(8),
    source: immutableRepositorySourceSchema,
    sourceProvenance: sourceProvenanceSchema,
  })
  .strict()
  .superRefine((input, context) => {
    const mismatches = [
      input.execution.candidates.length !== input.budget.requiredRuns,
      input.source.commitSha !== input.sourceProvenance.commitSha,
      input.source.repositoryId !== input.sourceProvenance.repositoryId,
      input.environment.sourceCommitSha !== input.source.commitSha,
      input.environment.archiveSha256 !== input.sourceProvenance.archiveSha256,
      input.environment.manifestSha256 !== input.sourceProvenance.manifestSha256,
      input.environment.lockfileSha256 !== input.dependency.lockfileSha256,
      input.environment.packageJsonSha256 !== input.dependency.packageJsonSha256,
      input.environment.dependencyPolicyVersion !== input.dependency.policyVersion,
      input.environment.runtime !== `node${input.profile.nodeVersion}`,
      Date.parse(input.generatedAt) < Date.parse(input.case.createdAt),
    ];
    if (mismatches.some(Boolean)) {
      context.addIssue({
        code: "custom",
        message: "proof inputs must share one immutable execution provenance",
        path: ["environment"],
      });
    }
  });

const proofProvenanceSchema = z
  .object({
    cleanupStatus: z.enum(["clean", "quarantined"]),
    dependency: dependencyMetadataSchema,
    environment: executionEnvironmentProvenanceSchema,
    limitsPolicyVersion: z.literal("sandbox-limits-v1"),
    source: sourceProvenanceSchema,
  })
  .strict();

export const repositoryProofResultSchema = z
  .object({
    budget: repositoryBudgetSchema,
    bundle: reproBundleSchema.nullable(),
    case: reproCaseSchema,
    evidence: z.array(evidenceItemSchema).min(3),
    files: z.record(z.string(), z.string()),
    hypotheses: z.array(hypothesisSchema).min(1),
    kind: z.literal("repository"),
    minimization: minimizationResultSchema.nullable(),
    oracle: failureOracleSchema,
    provenance: proofProvenanceSchema,
    runs: z.array(runResultSchema).min(2).max(6),
    summary: verificationSummarySchema,
  })
  .strict()
  .superRefine((result, context) => {
    if (result.case.state !== result.summary.status) {
      context.addIssue({
        code: "custom",
        message: "terminal case state must equal deterministic proof status",
        path: ["case", "state"],
      });
    }
    const verified = result.summary.status === "VERIFIED";
    if (
      verified !== (result.bundle !== null) ||
      verified !== (result.minimization !== null) ||
      verified !== (Object.keys(result.files).length > 0)
    ) {
      context.addIssue({
        code: "custom",
        message: "only verified proof may contain minimization and bundle artifacts",
        path: ["bundle"],
      });
    }
    const evidenceIds = new Set(result.evidence.map((item) => item.id));
    result.hypotheses.forEach((hypothesis, index) => {
      if (hypothesis.evidenceIds.some((id) => !evidenceIds.has(id))) {
        context.addIssue({
          code: "custom",
          message: "hypothesis evidence must exist in the same proof",
          path: ["hypotheses", index, "evidenceIds"],
        });
      }
    });
  });

export type RepositoryProofResult = z.infer<
  typeof repositoryProofResultSchema
>;
export type RepositoryProofInput = z.input<typeof repositoryProofInputSchema>;

export class RepositoryProofInputError extends Error {
  readonly code = "INVALID_PROOF_INPUT" as const;

  constructor() {
    super("Repository execution evidence did not share one trusted provenance");
    this.name = "RepositoryProofInputError";
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function reproductionCommand(input: {
  profile: z.infer<typeof nodeRepositoryProfileSchema>;
}): string {
  return [
    "npm",
    "run",
    shellQuote(input.profile.reproductionScript),
    ...(input.profile.testNamePattern
      ? ["--", "--testNamePattern", shellQuote(input.profile.testNamePattern)]
      : []),
  ].join(" ");
}

function persistedRun(run: BoundedRun, secrets: string[]): RunResult {
  return runResultSchema.parse({
    ...redactSecrets(run.run, secrets),
    capture: {
      stderr: {
        originalBytes: run.capture.stderr.originalBytes,
        sha256: run.capture.stderr.sha256,
        truncated: run.capture.stderr.truncated,
      },
      stdout: {
        originalBytes: run.capture.stdout.originalBytes,
        sha256: run.capture.stdout.sha256,
        truncated: run.capture.stdout.truncated,
      },
    },
    stderr: redactSecrets(run.capture.stderr.text, secrets),
    stdout: redactSecrets(run.capture.stdout.text, secrets),
  });
}

function proofEvidence(
  input: z.infer<typeof repositoryProofInputSchema>,
): EvidenceItem[] {
  const issue = input.issueEvidence;
  return [
    evidenceItemSchema.parse({
      classification: issue ? "reported" : "unknown",
      content: redactSecrets(
        issue?.title ?? "No issue title was supplied with the repository request.",
        input.secrets,
      ),
      id: "evidence-repository-request",
      source: issue
        ? `${input.source.fullName} issue #${issue.number}`
        : "repository request",
    }),
    evidenceItemSchema.parse({
      classification: "observed",
      content: `Acquired immutable commit ${input.source.commitSha} as ${input.sourceProvenance.fileCount} regular files under source policy ${input.sourceProvenance.policyVersion}.`,
      id: "evidence-source-provenance",
      source: "ReproForge source validator",
    }),
    evidenceItemSchema.parse({
      classification: "observed",
      content: `Executed one control and ${input.execution.candidates.length} clean candidates in ${input.environment.runtime} with deny-all network policy.`,
      id: "evidence-clean-runs",
      source: "ReproForge isolated runner",
    }),
  ];
}

function proofHypothesis(
  input: z.infer<typeof repositoryProofInputSchema>,
  summary: VerificationSummary,
): Hypothesis {
  const status =
    summary.status === "VERIFIED"
      ? "supported"
      : summary.status === "NOT_REPRODUCED"
        ? "contradicted"
        : "inconclusive";
  return hypothesisSchema.parse({
    evidenceIds: [
      "evidence-repository-request",
      "evidence-source-provenance",
      "evidence-clean-runs",
    ],
    expectedSignal: `The ${input.profile.reproductionScript} script matches oracle ${input.oracle.id} in every clean candidate while ${input.profile.controlScript} does not.`,
    falsificationCondition:
      "The control matches, a required clean candidate does not match, or run environments differ.",
    id: "hypothesis-requested-reproduction",
    priority: 1,
    statement:
      "The declared reproduction script deterministically triggers the versioned failure signature.",
    status,
    statusHistory: [
      {
        reason: "Created from the typed repository request and immutable revision.",
        sequence: 0,
        status: "proposed",
      },
      {
        reason: summary.reason,
        sequence: 1,
        status,
      },
    ],
  });
}

function terminalCase(
  initial: ReproCase,
  summary: VerificationSummary,
  generatedAt: string,
): ReproCase {
  const generated = Date.parse(generatedAt);
  const started = Date.parse(initial.createdAt);
  const transitionCount = summary.status === "VERIFIED" ? 8 : 6;
  const first = Math.max(started, generated - transitionCount);
  let sequence = 0;
  let current = initial;
  const move = (state: CaseState, reason: string) => {
    current = transitionCase(
      current,
      state,
      reason,
      new Date(first + sequence),
    );
    sequence += 1;
  };
  move("INGESTING", "Validated the immutable repository request.");
  move("INSPECTING", "Validated source, dependency, and environment provenance.");
  move("HYPOTHESIZING", "Pinned the typed versioned failure oracle.");
  move("EXPERIMENTING", "Ran one control and clean isolated candidate microVMs.");
  move("VERIFYING", "Evaluated only machine run evidence with the versioned oracle.");
  if (summary.status !== "VERIFIED") {
    move(summary.status, summary.reason);
    return current;
  }
  move("MINIMIZING", "Evaluated the verified baseline for safe local reduction.");
  move("PACKAGING", "Materialized and validated the content-addressed bundle.");
  move("VERIFIED", summary.reason);
  return current;
}

export async function assembleRepositoryProof(
  rawInput: RepositoryProofInput,
): Promise<RepositoryProofResult> {
  const parsed = repositoryProofInputSchema.safeParse(rawInput);
  if (!parsed.success) throw new RepositoryProofInputError();
  const input = parsed.data;
  const control = persistedRun(input.execution.control, input.secrets);
  const candidates = input.execution.candidates.map((run) =>
    persistedRun(run, input.secrets),
  );
  const summary = verifyReproduction({
    candidates,
    control,
    oracle: input.oracle,
    requiredRuns: input.budget.requiredRuns,
  });
  const evidence = proofEvidence(input);
  const hypotheses = [proofHypothesis(input, summary)];
  const currentCase = terminalCase(input.case, summary, input.generatedAt);
  const runs = [control, ...candidates];

  let bundle = null;
  let minimization = null;
  let files: Record<string, string> = {};
  if (summary.status === "VERIFIED") {
    minimization = minimizeReproduction({
      baseline: { candidates, control },
      oracle: input.oracle,
      proposals: [],
      requiredRuns: input.budget.requiredRuns,
    });
    bundle = await createBundle({
      caseId: currentCase.id,
      generatedAt: input.generatedAt,
      hypothesisLedger: hypotheses,
      lock: {
        command: reproductionCommand(input),
        dependencyLockHash: input.dependency.lockfileSha256,
        environment: {
          NETWORK: "denied",
          NODE_VERSION: input.environment.nodeVersion,
          NPM_VERSION: input.environment.npmVersion,
          REPROFORGE_EXECUTION_POLICY: input.environment.executionPolicyVersion,
          REPROFORGE_LIMITS_POLICY: input.execution.limitsPolicyVersion,
          REPROFORGE_SOURCE_POLICY: input.sourceProvenance.policyVersion,
        },
        environmentHash: input.environment.environmentHash,
        oracleId: input.oracle.id,
        oracleVersion: input.oracle.version,
        packageManager: `npm@${input.environment.npmVersion}`,
        repository: input.source.fullName,
        repositoryTreeHash: input.sourceProvenance.manifestSha256,
        reproForgeVersion: "0.2.0",
        revision: input.source.commitSha,
        runner: `vercel-sandbox/${input.execution.limitsPolicyVersion}`,
        runtime: `node@${input.environment.nodeVersion}`,
      },
      minimization,
      oracle: input.oracle,
      reproductionPatch: "",
      runLog: runs,
      summary,
    });
    files = materializeBundle(bundle);
    if (!validateMaterializedBundle(files).success) {
      throw new RepositoryProofInputError();
    }
  }

  return repositoryProofResultSchema.parse({
    budget: input.budget,
    bundle,
    case: currentCase,
    evidence,
    files,
    hypotheses,
    kind: "repository",
    minimization,
    oracle: input.oracle,
    provenance: {
      cleanupStatus: input.cleanupStatus,
      dependency: input.dependency,
      environment: input.environment,
      limitsPolicyVersion: input.execution.limitsPolicyVersion,
      source: input.sourceProvenance,
    },
    runs,
    summary,
  });
}
