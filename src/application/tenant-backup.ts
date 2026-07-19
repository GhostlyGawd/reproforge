import { createHash } from "node:crypto";

import { z } from "zod";

import {
  artifactDescriptorSchema,
  type ArtifactDescriptor,
} from "@/application/ports/production";
import { reproductionSnapshotSchema } from "@/application/reproduction-contracts";
import { canonicalJson } from "@/domain/bundle";
import { TERMINAL_CASE_STATES } from "@/domain/case";
import { JOB_TERMINAL_STATES } from "@/domain/job";

const opaqueIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const timestampSchema = z.string().datetime();
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const jsonObjectSchema = z.record(z.string(), z.unknown());

const durableRecordSchema = z
  .object({
    callerId: opaqueIdSchema,
    caseId: opaqueIdSchema,
    commandHash: sha256Schema,
    createdAt: timestampSchema,
    idempotencyKey: z.string().min(1).max(128),
    jobId: opaqueIdSchema,
    snapshot: reproductionSnapshotSchema,
    tenantId: opaqueIdSchema,
    updatedAt: timestampSchema,
    version: z.number().int().positive(),
  })
  .strict()
  .superRefine((record, context) => {
    if (
      record.caseId !== record.snapshot.case.id ||
      record.jobId !== record.snapshot.job.id ||
      record.caseId !== record.snapshot.job.caseId
    ) {
      context.addIssue({
        code: "custom",
        message: "record identities must agree",
        path: ["snapshot"],
      });
    }
    if (Date.parse(record.updatedAt) < Date.parse(record.createdAt)) {
      context.addIssue({
        code: "custom",
        message: "updatedAt must not precede createdAt",
        path: ["updatedAt"],
      });
    }
    const failure = record.snapshot.job.failure;
    if (
      failure &&
      (!/^[A-Z][A-Z0-9_]{0,95}$/.test(failure.code) ||
        failure.message.length > 512 ||
        /[\u0000-\u001f\u007f]/.test(failure.message) ||
        /(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|bearer\s+\S{8,}|postgres(?:ql)?:\/\/[^@\s]+@)/i.test(
          failure.message,
        ))
    ) {
      context.addIssue({
        code: "custom",
        message: "job failure must be sanitized",
        path: ["snapshot", "job", "failure"],
      });
    }
  });

export const tenantBackupReproductionSchema = z
  .object({
    cancellation: z
      .object({
        cancelledAt: timestampSchema.nullable(),
        requestedAt: timestampSchema.nullable(),
      })
      .strict(),
    caseRetentionUntil: timestampSchema,
    idempotencyCreatedAt: timestampSchema,
    idempotencyExpiresAt: timestampSchema,
    jobMaxAttempts: z.number().int().positive().max(100),
    jobNextAttemptAt: timestampSchema,
    jobRetentionUntil: timestampSchema,
    record: durableRecordSchema,
    sourceDescriptor: jsonObjectSchema,
    sourceKind: z.enum(["github", "trusted-sample"]),
  })
  .strict()
  .superRefine((reproduction, context) => {
    const { record } = reproduction;
    if (!TERMINAL_CASE_STATES.includes(record.snapshot.case.state as never)) {
      context.addIssue({
        code: "custom",
        message: "backup cases must be terminal",
        path: ["record", "snapshot", "case", "state"],
      });
    }
    if (!JOB_TERMINAL_STATES.includes(record.snapshot.job.state as never)) {
      context.addIssue({
        code: "custom",
        message: "backup jobs must be terminal",
        path: ["record", "snapshot", "job", "state"],
      });
    }
    const cancelled = record.snapshot.job.state === "CANCELLED";
    if (
      cancelled !==
      Boolean(
        reproduction.cancellation.requestedAt &&
          reproduction.cancellation.cancelledAt,
      ) ||
      (reproduction.cancellation.requestedAt === null) !==
        (reproduction.cancellation.cancelledAt === null)
    ) {
      context.addIssue({
        code: "custom",
        message: "cancellation timestamps must match the terminal state",
        path: ["cancellation"],
      });
    }
    if (
      record.snapshot.job.state === "SUCCEEDED" &&
      record.snapshot.case.state !== "VERIFIED"
    ) {
      context.addIssue({
        code: "custom",
        message: "a successful job requires a verified case",
        path: ["record", "snapshot"],
      });
    }
    if (
      Date.parse(reproduction.caseRetentionUntil) <=
        Date.parse(record.createdAt) ||
      Date.parse(reproduction.jobRetentionUntil) <=
        Date.parse(record.snapshot.job.createdAt) ||
      Date.parse(reproduction.idempotencyExpiresAt) <=
        Date.parse(reproduction.idempotencyCreatedAt) ||
      record.snapshot.job.attempt > reproduction.jobMaxAttempts
    ) {
      context.addIssue({
        code: "custom",
        message: "reproduction retention or attempt bounds are invalid",
        path: ["record"],
      });
    }
  });

export const tenantBackupEvidenceSchema = z
  .object({
    attempt: z.number().int().positive().max(100),
    caseId: opaqueIdSchema,
    commandHash: sha256Schema.nullable(),
    createdAt: timestampSchema,
    durationMs: z.number().int().nonnegative().nullable(),
    environment: jsonObjectSchema,
    evidence: jsonObjectSchema,
    exitCode: z.number().int().nullable(),
    jobId: opaqueIdSchema,
    kind: z.enum([
      "positive-control",
      "negative-control",
      "environment",
      "observation",
      "output",
    ]),
    leaseOwner: opaqueIdSchema.nullable(),
    passed: z.boolean().nullable(),
    retentionUntil: timestampSchema,
    sequence: z.number().int().positive(),
    tenantId: opaqueIdSchema,
  })
  .strict()
  .refine(
    (evidence) =>
      Date.parse(evidence.retentionUntil) > Date.parse(evidence.createdAt),
    { message: "evidence retention must follow creation" },
  );

export const tenantBackupManifestSchema = z
  .object({
    artifacts: z.array(artifactDescriptorSchema),
    createdAt: timestampSchema,
    evidence: z.array(tenantBackupEvidenceSchema),
    reproductions: z.array(tenantBackupReproductionSchema),
    schemaVersion: z.literal("1.0"),
    tenant: z
      .object({
        createdAt: timestampSchema,
        retentionUntil: timestampSchema.nullable(),
        status: z.literal("ACTIVE"),
        tenantId: opaqueIdSchema,
        updatedAt: timestampSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((manifest, context) => {
    const tenantId = manifest.tenant.tenantId;
    const caseIds = new Set<string>();
    const jobIds = new Set<string>();
    const idempotencyIdentities = new Set<string>();
    for (const [index, reproduction] of manifest.reproductions.entries()) {
      const { record } = reproduction;
      if (record.tenantId !== tenantId) {
        context.addIssue({
          code: "custom",
          message: "reproduction tenant must match manifest tenant",
          path: ["reproductions", index, "record", "tenantId"],
        });
      }
      if (caseIds.has(record.caseId) || jobIds.has(record.jobId)) {
        context.addIssue({
          code: "custom",
          message: "case and job identities must be unique",
          path: ["reproductions", index],
        });
      }
      caseIds.add(record.caseId);
      jobIds.add(record.jobId);
      const idempotencyIdentity = JSON.stringify([
        record.callerId,
        record.idempotencyKey,
      ]);
      if (idempotencyIdentities.has(idempotencyIdentity)) {
        context.addIssue({
          code: "custom",
          message: "idempotency identities must be unique",
          path: ["reproductions", index, "record", "idempotencyKey"],
        });
      }
      idempotencyIdentities.add(idempotencyIdentity);
    }

    const evidenceIdentities = new Set<string>();
    for (const [index, evidence] of manifest.evidence.entries()) {
      const identity = JSON.stringify([
        evidence.jobId,
        evidence.attempt,
        evidence.sequence,
      ]);
      const reproduction = manifest.reproductions.find(
        ({ record }) => record.jobId === evidence.jobId,
      );
      if (
        evidence.tenantId !== tenantId ||
        !reproduction ||
        reproduction.record.caseId !== evidence.caseId ||
        evidence.attempt > reproduction.record.snapshot.job.attempt ||
        evidenceIdentities.has(identity)
      ) {
        context.addIssue({
          code: "custom",
          message: "evidence must reference one unique manifest attempt",
          path: ["evidence", index],
        });
      }
      evidenceIdentities.add(identity);
    }

    const artifactIds = new Set<string>();
    const objectKeys = new Set<string>();
    for (const [index, artifact] of manifest.artifacts.entries()) {
      if (
        artifact.tenantId !== tenantId ||
        !caseIds.has(artifact.caseId) ||
        artifactIds.has(artifact.artifactId) ||
        objectKeys.has(artifact.objectKey)
      ) {
        context.addIssue({
          code: "custom",
          message: "artifacts must be unique and reference a manifest case",
          path: ["artifacts", index],
        });
      }
      artifactIds.add(artifact.artifactId);
      objectKeys.add(artifact.objectKey);
    }
    for (const [index, reproduction] of manifest.reproductions.entries()) {
      if (
        reproduction.record.snapshot.job.state === "SUCCEEDED" &&
        !manifest.artifacts.some(
          (artifact) =>
            artifact.caseId === reproduction.record.caseId &&
            artifact.kind === "bundle",
        )
      ) {
        context.addIssue({
          code: "custom",
          message: "a successful reproduction requires a bundle artifact",
          path: ["reproductions", index],
        });
      }
    }
  });

export type TenantBackupManifest = z.infer<typeof tenantBackupManifestSchema>;
export type TenantBackupReproduction = z.infer<
  typeof tenantBackupReproductionSchema
>;
export type TenantBackupEvidence = z.infer<typeof tenantBackupEvidenceSchema>;

export type TenantBackupArchive = Readonly<{
  manifest: TenantBackupManifest;
  manifestSha256: string;
  objects: Readonly<Record<string, Uint8Array>>;
}>;

export type TenantBackupLogEvent = Readonly<{
  artifactCount: number;
  at: string;
  byteCount: number;
  caseCount: number;
  code: string;
  event:
    | "tenant-backup.exported"
    | "tenant-backup.restored"
    | "tenant-backup.verified";
  evidenceCount: number;
  level: "error" | "info";
  manifestSha256: string;
  outcome: "failure" | "success";
  tenantId: string;
}>;

export interface TenantBackupLogger {
  emit(event: TenantBackupLogEvent): void;
}

export class TenantBackupError extends Error {
  constructor(
    readonly code:
      | "TENANT_BACKUP_CORRUPT"
      | "TENANT_BACKUP_FAILED"
      | "TENANT_BACKUP_NOT_FOUND"
      | "TENANT_BACKUP_NOT_QUIESCENT"
      | "TENANT_BACKUP_PROVIDER_UNAVAILABLE"
      | "TENANT_RESTORE_FAILED"
      | "TENANT_RESTORE_TARGET_EXISTS"
      | "TENANT_RESTORE_VERIFICATION_FAILED",
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "TenantBackupError";
  }
}

function corrupt(): TenantBackupError {
  return new TenantBackupError(
    "TENANT_BACKUP_CORRUPT",
    "The tenant backup failed canonical integrity validation",
    false,
  );
}

export function tenantBackupManifestSha256(
  manifest: TenantBackupManifest,
): string {
  return createHash("sha256")
    .update(canonicalJson(manifest))
    .digest("hex");
}

export function verifyTenantBackupArchive(
  rawArchive: TenantBackupArchive,
): TenantBackupArchive {
  let manifest: TenantBackupManifest;
  try {
    manifest = tenantBackupManifestSchema.parse(rawArchive.manifest);
  } catch {
    throw corrupt();
  }
  const manifestSha256 = tenantBackupManifestSha256(manifest);
  if (rawArchive.manifestSha256 !== manifestSha256) throw corrupt();

  const expectedKeys = manifest.artifacts
    .map(({ objectKey }) => objectKey)
    .sort();
  const actualKeys = Object.keys(rawArchive.objects).sort();
  if (JSON.stringify(expectedKeys) !== JSON.stringify(actualKeys)) {
    throw corrupt();
  }
  const objects: Record<string, Uint8Array> = {};
  for (const artifact of manifest.artifacts) {
    const body = rawArchive.objects[artifact.objectKey];
    if (
      !(body instanceof Uint8Array) ||
      body.byteLength !== artifact.byteCount ||
      createHash("sha256").update(body).digest("hex") !== artifact.sha256
    ) {
      throw corrupt();
    }
    objects[artifact.objectKey] = Uint8Array.from(body);
  }
  return {
    manifest: structuredClone(manifest),
    manifestSha256,
    objects,
  };
}

export function sealTenantBackupArchive(
  rawManifest: TenantBackupManifest,
  objects: Readonly<Record<string, Uint8Array>>,
): TenantBackupArchive {
  let manifest: TenantBackupManifest;
  try {
    manifest = tenantBackupManifestSchema.parse(rawManifest);
  } catch {
    throw corrupt();
  }
  return verifyTenantBackupArchive({
    manifest,
    manifestSha256: tenantBackupManifestSha256(manifest),
    objects,
  });
}

export function backupArtifactByteCount(
  artifacts: readonly ArtifactDescriptor[],
): number {
  return artifacts.reduce((sum, artifact) => sum + artifact.byteCount, 0);
}
