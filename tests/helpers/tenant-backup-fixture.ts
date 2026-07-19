import { createHash } from "node:crypto";

import type { PGlite } from "@electric-sql/pglite";

import type { ArtifactDescriptor } from "@/application/ports/production";
import { runTrustedSample } from "@/application/sample-case";
import { createJob, transitionJob } from "@/domain/job";
import { ContentAddressedArtifactStore } from "@/infrastructure/artifacts/content-addressed-store";

import { MemoryPrivateBlobClient } from "./memory-private-blob-client";
import { pglitePostgresDatabase } from "./pglite-postgres-database";

const CREATED_AT = "2026-07-19T20:00:00.000Z";
const RUNNING_AT = "2026-07-19T20:00:01.000Z";
const EVIDENCE_AT = "2026-07-19T20:00:02.000Z";
const COMPLETED_AT = "2026-07-19T20:00:03.000Z";
const RETENTION_UNTIL = "2099-07-19T20:00:00.000Z";
export const BACKUP_BODY_MARKER =
  "private verified bundle body: never serialize this object body";

export type VerifiedBackupFixture = Readonly<{
  artifact: ArtifactDescriptor;
  body: Uint8Array;
  callerId: string;
  caseId: string;
  jobId: string;
  tenantId: string;
}>;

export async function seedVerifiedBackupTenant(
  database: PGlite,
  blobs: MemoryPrivateBlobClient,
  tenantId = "tenant_backup",
): Promise<VerifiedBackupFixture> {
  const caseId = `case_${tenantId}`;
  const jobId = `job_${tenantId}`;
  const callerId = `caller_${tenantId}`;
  const result = await runTrustedSample({
    caseId,
    startedAt: new Date(CREATED_AT),
  });
  const runningJob = transitionJob(
    createJob(jobId, caseId, new Date(CREATED_AT)),
    "RUNNING",
    { at: new Date(RUNNING_AT), progressPhase: "INGESTING" },
  );
  const completedJob = transitionJob(runningJob, "SUCCEEDED", {
    at: new Date(COMPLETED_AT),
    progressPhase: "VERIFIED",
  });
  const domainState = {
    case: result.case,
    result,
    sampleId: "cli-spaces",
    schemaVersion: "2.0",
  };

  await database.query(
    `INSERT INTO tenants (id, created_at, updated_at, retention_until)
     VALUES ($1, $2, $2, $3)`,
    [tenantId, CREATED_AT, RETENTION_UNTIL],
  );
  await database.query(
    `INSERT INTO cases (
       tenant_id, id, source_kind, source_descriptor, state, domain_state,
       schema_version, version, created_at, updated_at, retention_until
     ) VALUES (
       $1, $2, 'trusted-sample', $3::jsonb, 'VERIFIED', $4::jsonb,
       '2.0', 1, $5, $6, $7
     )`,
    [
      tenantId,
      caseId,
      JSON.stringify({ sampleId: "cli-spaces" }),
      JSON.stringify(domainState),
      CREATED_AT,
      RUNNING_AT,
      RETENTION_UNTIL,
    ],
  );
  await database.query(
    `INSERT INTO jobs (
       tenant_id, id, case_id, state, progress_phase, attempt, max_attempts,
       next_attempt_at, lease_owner, lease_acquired_at, lease_expires_at,
       version, created_at, updated_at, retention_until
     ) VALUES (
       $1, $2, $3, 'RUNNING', $4, 1, 3,
       $5, $6, $5, $7, 1, $8, $5, $9
     )`,
    [
      tenantId,
      jobId,
      caseId,
      runningJob.progressPhase,
      RUNNING_AT,
      "worker_backup",
      "2026-07-19T20:05:00.000Z",
      CREATED_AT,
      RETENTION_UNTIL,
    ],
  );
  await database.query(
    `INSERT INTO idempotency_keys (
       tenant_id, caller_id, idempotency_key, command_hash, case_id, job_id,
       created_at, expires_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      tenantId,
      callerId,
      `start_${tenantId}`,
      "a".repeat(64),
      caseId,
      jobId,
      CREATED_AT,
      RETENTION_UNTIL,
    ],
  );
  await database.query(
    `INSERT INTO run_evidence (
       tenant_id, case_id, job_id, attempt, sequence, kind, command_hash,
       exit_code, passed, duration_ms, environment, evidence, lease_owner,
       created_at, retention_until
     ) VALUES (
       $1, $2, $3, 1, 1, 'positive-control', $4,
       0, true, 12, $5::jsonb, $6::jsonb, $7, $8, $9
     )`,
    [
      tenantId,
      caseId,
      jobId,
      "b".repeat(64),
      JSON.stringify({ network: "denied", runtime: "node@24" }),
      JSON.stringify({ observation: "control passed" }),
      "worker_backup",
      EVIDENCE_AT,
      RETENTION_UNTIL,
    ],
  );

  const body = new TextEncoder().encode(BACKUP_BODY_MARKER);
  const sha256 = createHash("sha256").update(body).digest("hex");
  const artifact: ArtifactDescriptor = {
    artifactId: `artifact_${tenantId}`,
    byteCount: body.byteLength,
    caseId,
    createdAt: EVIDENCE_AT,
    kind: "bundle",
    objectKey: `tenants/${tenantId}/cases/${caseId}/bundle/${sha256}`,
    retentionUntil: RETENTION_UNTIL,
    sha256,
    tenantId,
  };
  const store = new ContentAddressedArtifactStore(
    pglitePostgresDatabase(database),
    blobs,
    { now: () => new Date(EVIDENCE_AT) },
  );
  await store.put({ bytes: body, descriptor: artifact });

  await database.query(
    `UPDATE jobs
        SET state = 'SUCCEEDED', progress_phase = $4,
            lease_owner = NULL, lease_acquired_at = NULL, lease_expires_at = NULL,
            updated_at = $5, version = 2
      WHERE tenant_id = $1 AND id = $2 AND case_id = $3`,
    [tenantId, jobId, caseId, completedJob.progressPhase, COMPLETED_AT],
  );
  await database.query(
    `UPDATE cases
        SET updated_at = $3, version = 2
      WHERE tenant_id = $1 AND id = $2`,
    [tenantId, caseId, COMPLETED_AT],
  );

  return { artifact, body, callerId, caseId, jobId, tenantId };
}
