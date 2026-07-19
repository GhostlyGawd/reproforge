import { createHash } from "node:crypto";

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  sealTenantBackupArchive,
  tenantBackupManifestSchema,
  verifyTenantBackupArchive,
} from "@/application/tenant-backup";
import { createCase, transitionCase } from "@/domain/case";
import { createJob, transitionJob } from "@/domain/job";

const AT = "2026-07-19T20:00:00.000Z";
const COMPLETED_AT = "2026-07-19T20:00:01.000Z";
const RETENTION_UNTIL = "2099-07-19T20:00:00.000Z";

describe("tenant backup integrity properties", () => {
  it("round-trips and detects mutation for 250 generated private object bodies", () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 1, maxLength: 512 }),
        (generatedBody) => {
          const body = Uint8Array.from(generatedBody);
          const sha256 = createHash("sha256").update(body).digest("hex");
          const caseId = "case_property_backup";
          const jobId = "job_property_backup";
          const tenantId = "tenant_property_backup";
          const cancelledCase = transitionCase(
            createCase(caseId, new Date(AT)),
            "CANCELLED",
            "Property fixture",
            new Date(COMPLETED_AT),
          );
          const cancelledJob = transitionJob(
            createJob(jobId, caseId, new Date(AT)),
            "CANCELLED",
            { at: new Date(COMPLETED_AT), progressPhase: "CANCELLED" },
          );
          const objectKey =
            `tenants/${tenantId}/cases/${caseId}/bundle/${sha256}`;
          const manifest = tenantBackupManifestSchema.parse({
            artifacts: [
              {
                artifactId: "artifact_property_backup",
                byteCount: body.byteLength,
                caseId,
                createdAt: AT,
                kind: "bundle",
                objectKey,
                retentionUntil: RETENTION_UNTIL,
                sha256,
                tenantId,
              },
            ],
            createdAt: COMPLETED_AT,
            evidence: [],
            reproductions: [
              {
                cancellation: {
                  cancelledAt: COMPLETED_AT,
                  requestedAt: COMPLETED_AT,
                },
                caseRetentionUntil: RETENTION_UNTIL,
                idempotencyCreatedAt: AT,
                idempotencyExpiresAt: RETENTION_UNTIL,
                jobMaxAttempts: 3,
                jobNextAttemptAt: AT,
                jobRetentionUntil: RETENTION_UNTIL,
                record: {
                  callerId: "caller_property_backup",
                  caseId,
                  commandHash: "a".repeat(64),
                  createdAt: AT,
                  idempotencyKey: "start_property_backup",
                  jobId,
                  snapshot: {
                    case: cancelledCase,
                    job: cancelledJob,
                    result: null,
                    sampleId: "cli-spaces",
                    schemaVersion: "2.0",
                  },
                  tenantId,
                  updatedAt: COMPLETED_AT,
                  version: 1,
                },
                sourceDescriptor: { sampleId: "cli-spaces" },
                sourceKind: "trusted-sample",
              },
            ],
            schemaVersion: "1.0",
            tenant: {
              createdAt: AT,
              retentionUntil: RETENTION_UNTIL,
              status: "ACTIVE",
              tenantId,
              updatedAt: AT,
            },
          });
          const archive = sealTenantBackupArchive(manifest, {
            [objectKey]: body,
          });

          expect(verifyTenantBackupArchive(archive).manifestSha256).toBe(
            archive.manifestSha256,
          );
          const mutated = Uint8Array.from(body);
          mutated[0] = (mutated[0] ?? 0) ^ 0xff;
          expect(() =>
            verifyTenantBackupArchive({
              ...archive,
              objects: { [objectKey]: mutated },
            }),
          ).toThrowError(
            expect.objectContaining({ code: "TENANT_BACKUP_CORRUPT" }),
          );
        },
      ),
      { numRuns: 250 },
    );
  });
});
