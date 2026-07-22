import { z } from "zod";

const toolNameSchema = z.enum([
  "start_reproduction",
  "list_authorized_repositories",
  "get_reproduction",
  "cancel_reproduction",
  "export_repro_bundle",
]);

const reviewCaseIdSchema = z.enum([
  "positive-trusted-demo",
  "positive-authorized-list",
  "positive-public-canary",
  "positive-private-canary",
  "positive-intermittent-canary",
  "negative-arbitrary-execution",
  "negative-cross-tenant-read",
  "negative-destructive-or-fabricated",
]);

const expectedReviewCaseIds = reviewCaseIdSchema.options;

const fixtureSchema = z
  .object({
    alias: z.string().regex(/^[a-z0-9-]+$/),
    dataClassification: z.literal("synthetic"),
    environment: z
      .array(z.string().regex(/^REPROFORGE_REVIEW_[A-Z0-9_]+$/))
      .max(8),
    kind: z.enum([
      "trusted_sample",
      "authorized_catalog",
      "deterministic_canary",
      "intermittent_canary",
      "authorization_boundary",
      "policy_attack",
    ]),
    publicCommitSha: z.string().regex(/^[a-f0-9]{40}$/).optional(),
    sampleId: z.literal("cli-spaces").optional(),
    visibility: z.enum(["none", "public", "private", "mixed"]),
  })
  .strict();

const expectedResultSchema = z
  .object({
    assertions: z
      .array(z.string().regex(/^[a-z][a-z0-9_]{2,95}$/))
      .min(1)
      .max(12),
    bundle: z.enum(["required", "forbidden", "not_applicable"]),
    narrationRules: z
      .array(
        z.enum([
          "no_private_identity",
          "no_secret_value",
          "no_cross_tenant_existence_leak",
          "no_unsupported_verification_claim",
        ]),
      )
      .max(4),
    outcome: z.enum([
      "VERIFIED",
      "REPOSITORY_LIST",
      "UNSTABLE",
      "REFUSED",
      "NOT_FOUND_OR_REAUTHORIZATION",
    ]),
  })
  .strict();

const protocolProbeSchema = z
  .object({
    expected: z.enum([
      "INVALID_PARAMS",
      "NOT_FOUND_OR_AUTHORIZATION",
    ]),
    inputTemplate: z.record(z.string(), z.unknown()),
    tool: toolNameSchema,
  })
  .strict();

const passEvidenceSchema = z
  .object({
    references: z.array(z.string().min(1).max(512)).max(12),
    status: z.enum(["pending_hosted", "passed"]),
  })
  .strict()
  .superRefine((evidence, context) => {
    if (evidence.status === "passed" && evidence.references.length === 0) {
      context.addIssue({
        code: "custom",
        message: "a passed review case requires evidence references",
      });
    }
    if (evidence.status === "pending_hosted" && evidence.references.length > 0) {
      context.addIssue({
        code: "custom",
        message: "pending hosted cases cannot claim pass evidence",
      });
    }
  });

export const reviewCaseSchema = z
  .object({
    contractReferences: z.array(z.string().min(1).max(256)).min(1).max(12),
    expectedResult: expectedResultSchema,
    expectedToolSequence: z.array(toolNameSchema).max(6),
    fixture: fixtureSchema,
    id: reviewCaseIdSchema,
    passEvidence: passEvidenceSchema,
    polarity: z.enum(["positive", "negative"]),
    prerequisites: z.array(z.string().min(1).max(512)).min(1).max(12),
    prompt: z.string().min(20).max(1_500),
    protocolProbe: protocolProbeSchema.optional(),
    title: z.string().min(3).max(128),
  })
  .strict();

export const reviewCasePackSchema = z
  .object({
    cases: z.array(reviewCaseSchema).length(8),
    reviewMode: z.literal("chatgpt-developer-mode"),
    schemaVersion: z.literal("1.0"),
    title: z.literal("ReproForge submission review cases"),
  })
  .strict()
  .superRefine((pack, context) => {
    const ids = pack.cases.map(({ id }) => id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: "custom", message: "review case IDs must be unique" });
    }
    if (ids.some((id, index) => id !== expectedReviewCaseIds[index])) {
      context.addIssue({
        code: "custom",
        message: "review cases must retain the approved portal order",
      });
    }

    const positives = pack.cases.filter(({ polarity }) => polarity === "positive");
    const negatives = pack.cases.filter(({ polarity }) => polarity === "negative");
    if (positives.length !== 5 || negatives.length !== 3) {
      context.addIssue({
        code: "custom",
        message: "review pack requires exactly five positive and three negative cases",
      });
    }

    pack.cases.forEach((reviewCase, index) => {
      const shouldBePositive = index < 5;
      if ((reviewCase.polarity === "positive") !== shouldBePositive) {
        context.addIssue({
          code: "custom",
          message: "case polarity does not match approved portal order",
          path: ["cases", index, "polarity"],
        });
      }
      if (
        reviewCase.expectedResult.bundle === "required" &&
        reviewCase.expectedResult.outcome !== "VERIFIED"
      ) {
        context.addIssue({
          code: "custom",
          message: "only a VERIFIED outcome may require a bundle",
          path: ["cases", index, "expectedResult", "bundle"],
        });
      }
      if (
        reviewCase.expectedResult.outcome === "UNSTABLE" &&
        reviewCase.expectedResult.bundle !== "forbidden"
      ) {
        context.addIssue({
          code: "custom",
          message: "UNSTABLE must forbid bundle export",
          path: ["cases", index, "expectedResult", "bundle"],
        });
      }
      if (
        reviewCase.fixture.visibility === "private" &&
        (reviewCase.fixture.publicCommitSha !== undefined ||
          !reviewCase.expectedResult.narrationRules.includes("no_private_identity"))
      ) {
        context.addIssue({
          code: "custom",
          message: "private fixtures must remain environment-bound and identity-redacted",
          path: ["cases", index, "fixture"],
        });
      }
      if (
        reviewCase.fixture.visibility === "public" &&
        reviewCase.fixture.kind === "deterministic_canary" &&
        reviewCase.fixture.publicCommitSha === undefined
      ) {
        context.addIssue({
          code: "custom",
          message: "the public deterministic canary requires an immutable public SHA",
          path: ["cases", index, "fixture", "publicCommitSha"],
        });
      }
      if (
        reviewCase.fixture.kind === "trusted_sample" &&
        reviewCase.fixture.sampleId !== "cli-spaces"
      ) {
        context.addIssue({
          code: "custom",
          message: "the trusted review fixture must remain cli-spaces",
          path: ["cases", index, "fixture", "sampleId"],
        });
      }
      if (reviewCase.polarity === "negative" && !reviewCase.protocolProbe) {
        context.addIssue({
          code: "custom",
          message: "every negative case requires an executable protocol probe",
          path: ["cases", index, "protocolProbe"],
        });
      }
    });
  });

export type ReviewCase = z.infer<typeof reviewCaseSchema>;
export type ReviewCasePack = z.infer<typeof reviewCasePackSchema>;

export function parseReviewCasePack(input: unknown): ReviewCasePack {
  return reviewCasePackSchema.parse(input);
}

export const reviewCaseObservationSchema = z
  .object({
    assertions: z.array(z.string().regex(/^[a-z][a-z0-9_]{2,95}$/)).max(20),
    bundle: z.enum(["required", "forbidden", "not_applicable"]),
    caseId: reviewCaseIdSchema,
    narration: z.string().min(1).max(4_000),
    outcome: expectedResultSchema.shape.outcome,
    sensitiveValueMatches: z.array(z.string().min(1).max(128)).default([]),
    toolSequence: z.array(toolNameSchema).max(12),
  })
  .strict();

export type ReviewCaseObservation = z.infer<typeof reviewCaseObservationSchema>;

export type ReviewCaseVerification = {
  failures: string[];
  passed: boolean;
};

export function verifyReviewCaseObservation(
  reviewCase: ReviewCase,
  rawObservation: ReviewCaseObservation,
): ReviewCaseVerification {
  const observation = reviewCaseObservationSchema.parse(rawObservation);
  const failures: string[] = [];

  if (observation.caseId !== reviewCase.id) failures.push("case_id_mismatch");
  if (observation.outcome !== reviewCase.expectedResult.outcome) {
    failures.push("outcome_mismatch");
  }
  if (observation.bundle !== reviewCase.expectedResult.bundle) {
    failures.push("bundle_disposition_mismatch");
  }
  if (
    JSON.stringify(observation.toolSequence) !==
    JSON.stringify(reviewCase.expectedToolSequence)
  ) {
    failures.push("tool_sequence_mismatch");
  }
  for (const assertion of reviewCase.expectedResult.assertions) {
    if (!observation.assertions.includes(assertion)) {
      failures.push(`missing_assertion:${assertion}`);
    }
  }

  if (
    reviewCase.expectedResult.narrationRules.some((rule) =>
      ["no_private_identity", "no_secret_value"].includes(rule),
    ) &&
    observation.sensitiveValueMatches.length > 0
  ) {
    failures.push("sensitive_value_disclosed");
  }
  if (
    reviewCase.expectedResult.narrationRules.includes(
      "no_unsupported_verification_claim",
    ) &&
    /\bverified\b/i.test(observation.narration)
  ) {
    failures.push("unsupported_verification_claim");
  }

  return { failures, passed: failures.length === 0 };
}
