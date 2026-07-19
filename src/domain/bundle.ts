import { createHash } from "node:crypto";

import { z } from "zod";

import { hypothesisSchema } from "./evidence";
import { failureOracleSchema } from "./oracle";
import { runResultSchema } from "./run";
import {
  verificationSummarySchema,
  type VerificationSummary,
} from "./verification";

const bundleLockSchema = z
  .object({
    command: z.string().min(1),
    environmentHash: z.string().min(1),
    packageManager: z.string().min(1),
    repository: z.string().min(1),
    revision: z.string().min(1),
    runner: z.string().min(1),
    runtime: z.string().min(1),
  })
  .strict();

export const reproBundleSchema = z
  .object({
    bundleHash: z.string().regex(/^[a-f0-9]{64}$/),
    caseId: z.string().min(1),
    generatedAt: z.string().datetime(),
    hypothesisLedger: z.array(hypothesisSchema),
    lock: bundleLockSchema,
    oracle: failureOracleSchema,
    reproductionPatch: z.string(),
    runLog: z.array(runResultSchema),
    schemaVersion: z.literal("1.0"),
    summary: verificationSummarySchema,
  })
  .strict()
  .superRefine((bundle, context) => {
    if (bundle.summary.status !== "VERIFIED") {
      context.addIssue({
        code: "custom",
        message: "Repro Bundles require a verified reproduction",
        path: ["summary", "status"],
      });
    }
    if (bundle.summary.oracleId !== bundle.oracle.id) {
      context.addIssue({
        code: "custom",
        message: "Summary oracle ID must match bundle oracle ID",
        path: ["summary", "oracleId"],
      });
    }
    if (bundle.summary.oracleVersion !== bundle.oracle.version) {
      context.addIssue({
        code: "custom",
        message: "Summary oracle version must match bundle oracle version",
        path: ["summary", "oracleVersion"],
      });
    }
  });

export type ReproBundle = z.infer<typeof reproBundleSchema>;
export type ReproBundleInput = Omit<ReproBundle, "bundleHash" | "schemaVersion">;

export const REQUIRED_BUNDLE_FILES = [
  "REPRO.md",
  "reproforge.lock.json",
  "failure-signature.json",
  "reproduction.patch",
  "artifacts/redacted-run-log.jsonl",
  "artifacts/hypothesis-ledger.json",
  "artifacts/verification-summary.json",
] as const;

const REDACTION_MARKER = "[REDACTED]";

function normalizeJson(value: unknown, seen = new WeakSet<object>()): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeJson(item, seen));
  }
  if (typeof value === "object") {
    if (seen.has(value)) {
      throw new TypeError("Cannot canonicalize cyclic data");
    }
    seen.add(value);
    const normalized = Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, normalizeJson(item, seen)]),
    );
    seen.delete(value);
    return normalized;
  }
  throw new TypeError(`Unsupported canonical JSON value: ${typeof value}`);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalizeJson(value));
}

export async function hashCanonical(value: unknown): Promise<string> {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function redactString(value: string, secrets: string[]): string {
  const unique = [...new Set(secrets.filter((secret) => secret.length > 0))].sort(
    (left, right) => right.length - left.length,
  );
  if (unique.length === 0) {
    return value;
  }
  const pattern = new RegExp(unique.map(escapeRegex).join("|"), "g");
  return value
    .split(REDACTION_MARKER)
    .map((segment) => segment.replace(pattern, REDACTION_MARKER))
    .join(REDACTION_MARKER);
}

export function redactSecrets<T>(value: T, secrets: string[]): T {
  if (typeof value === "string") {
    return redactString(value, secrets) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item, secrets)) as T;
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactSecrets(item, secrets)]),
    ) as T;
  }
  return value;
}

export async function createBundle(input: ReproBundleInput): Promise<ReproBundle> {
  const base = {
    ...input,
    schemaVersion: "1.0" as const,
  };
  return reproBundleSchema.parse({
    ...base,
    bundleHash: await hashCanonical(base),
  });
}

function reproductionMarkdown(bundle: ReproBundle): string {
  return [
    "# Reproduction",
    "",
    `Case: \`${bundle.caseId}\``,
    `Bundle: \`${bundle.bundleHash}\``,
    "",
    "## Run",
    "",
    "```bash",
    bundle.lock.command,
    "```",
    "",
    "## Expected failure",
    "",
    bundle.summary.reason,
    "",
  ].join("\n");
}

export function materializeBundle(bundle: ReproBundle): Record<string, string> {
  const parsed = reproBundleSchema.parse(bundle);
  return {
    "REPRO.md": reproductionMarkdown(parsed),
    "reproforge.lock.json": JSON.stringify(
      { bundleHash: parsed.bundleHash, schemaVersion: parsed.schemaVersion, ...parsed.lock },
      null,
      2,
    ),
    "failure-signature.json": JSON.stringify(parsed.oracle, null, 2),
    "reproduction.patch": parsed.reproductionPatch,
    "artifacts/redacted-run-log.jsonl": parsed.runLog
      .map((run) => JSON.stringify(run))
      .join("\n"),
    "artifacts/hypothesis-ledger.json": JSON.stringify(parsed.hypothesisLedger, null, 2),
    "artifacts/verification-summary.json": JSON.stringify(parsed.summary, null, 2),
  };
}

export type BundleValidationResult =
  | { success: true; errors: [] }
  | { success: false; errors: string[] };

export function validateMaterializedBundle(
  files: Record<string, string>,
): BundleValidationResult {
  const errors: string[] = [];
  for (const required of REQUIRED_BUNDLE_FILES) {
    if (!(required in files)) {
      errors.push(`Missing required file: ${required}`);
    }
  }

  const parse = (path: string, schema: z.ZodType): void => {
    try {
      schema.parse(JSON.parse(files[path] ?? ""));
    } catch {
      errors.push(`Invalid ${path}`);
    }
  };

  parse("failure-signature.json", failureOracleSchema);
  parse("artifacts/hypothesis-ledger.json", z.array(hypothesisSchema));
  parse("artifacts/verification-summary.json", verificationSummarySchema);

  if (!(files["REPRO.md"] ?? "").includes("## Run")) {
    errors.push("REPRO.md does not contain a run command");
  }

  const runLog = files["artifacts/redacted-run-log.jsonl"] ?? "";
  for (const line of runLog.split("\n").filter(Boolean)) {
    try {
      runResultSchema.parse(JSON.parse(line));
    } catch {
      errors.push("Invalid artifacts/redacted-run-log.jsonl");
      break;
    }
  }

  return errors.length === 0
    ? { success: true, errors: [] }
    : { success: false, errors };
}

export function summaryRequiresVerified(
  summary: VerificationSummary,
): asserts summary is VerificationSummary & { status: "VERIFIED" } {
  if (summary.status !== "VERIFIED") {
    throw new Error("Only verified reproductions can be exported as a Repro Bundle");
  }
}
