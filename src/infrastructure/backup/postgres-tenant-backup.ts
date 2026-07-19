import {
  TenantBackupError,
  backupArtifactByteCount,
  sealTenantBackupArchive,
  tenantBackupManifestSchema,
  verifyTenantBackupArchive,
  type TenantBackupArchive,
  type TenantBackupEvidence,
  type TenantBackupLogger,
  type TenantBackupManifest,
  type TenantBackupReproduction,
} from "@/application/tenant-backup";
import { artifactDescriptorSchema } from "@/application/ports/production";
import { reproductionSnapshotSchema } from "@/application/reproduction-contracts";
import type {
  PrivateBlobClient,
  PrivateBlobMetadata,
} from "@/infrastructure/artifacts/private-blob-client";
import {
  runSerializableTransaction,
  type PostgresDatabase,
  type PostgresExecutor,
} from "@/infrastructure/postgres/database";

type TenantRow = {
  created_at: Date | string;
  id: string;
  retention_until: Date | string | null;
  status: string;
  updated_at: Date | string;
};

type ReproductionRow = {
  caller_id: string;
  cancellation_requested_at: Date | string | null;
  cancelled_at: Date | string | null;
  case_created_at: Date | string;
  case_domain_state: unknown;
  case_id: string;
  case_retention_until: Date | string;
  case_state: string;
  case_updated_at: Date | string;
  case_version: number | string;
  command_hash: string;
  idempotency_created_at: Date | string;
  idempotency_expires_at: Date | string;
  idempotency_key: string;
  job_attempt: number | string;
  job_created_at: Date | string;
  job_failure_code: string | null;
  job_failure_message: string | null;
  job_failure_retryable: boolean | null;
  job_id: string;
  job_max_attempts: number | string;
  job_next_attempt_at: Date | string;
  job_progress_phase: string;
  job_retention_until: Date | string;
  job_state: string;
  job_updated_at: Date | string;
  job_version: number | string;
  source_descriptor: unknown;
  source_kind: "github" | "trusted-sample";
  tenant_id: string;
};

type EvidenceRow = {
  attempt: number | string;
  case_id: string;
  command_hash: string | null;
  created_at: Date | string;
  duration_ms: number | string | null;
  environment: unknown;
  evidence: unknown;
  exit_code: number | string | null;
  job_id: string;
  kind: TenantBackupEvidence["kind"];
  lease_owner: string | null;
  passed: boolean | null;
  retention_until: Date | string;
  sequence: number | string;
  tenant_id: string;
};

type ArtifactRow = {
  byte_count: number | string;
  case_id: string;
  created_at: Date | string;
  id: string;
  kind: TenantBackupManifest["artifacts"][number]["kind"];
  object_key: string;
  provider_etag: string;
  retention_until: Date | string;
  sha256: string;
  tenant_id: string;
};

type RestoreRow = {
  backup_sha256: string | null;
  state: "RESTORED" | "RUNNING" | "VERIFIED" | null;
  tenant_id: string;
};

export type TenantRestoreResult = Readonly<{
  artifactCount: number;
  caseCount: number;
  evidenceCount: number;
  manifestSha256: string;
  restored: boolean;
  tenantId: string;
}>;

function backupError(
  code: TenantBackupError["code"],
  message: string,
  retryable = false,
): TenantBackupError {
  return new TenantBackupError(code, message, retryable);
}

function timestamp(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw backupError(
      "TENANT_BACKUP_CORRUPT",
      "The stored tenant timestamp is invalid",
    );
  }
  return parsed.toISOString();
}

function integer(value: number | string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw backupError(
      "TENANT_BACKUP_CORRUPT",
      "The stored tenant numeric value is invalid",
    );
  }
  return parsed;
}

function objectValue(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return objectValue(JSON.parse(value));
    } catch {
      throw backupError(
        "TENANT_BACKUP_CORRUPT",
        "The stored tenant JSON value is invalid",
      );
    }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw backupError(
      "TENANT_BACKUP_CORRUPT",
      "The stored tenant JSON value is invalid",
    );
  }
  return structuredClone(value as Record<string, unknown>);
}

function nullableTimestamp(value: Date | string | null): string | null {
  return value === null ? null : timestamp(value);
}

function retentionClass(
  kind: TenantBackupManifest["artifacts"][number]["kind"],
): "backup" | "bundle" | "run" | "source" {
  if (kind === "backup-manifest") return "backup";
  if (kind === "bundle") return "bundle";
  if (kind === "source") return "source";
  return "run";
}

function summary(
  archive: TenantBackupArchive,
  restored: boolean,
): TenantRestoreResult {
  return {
    artifactCount: archive.manifest.artifacts.length,
    caseCount: archive.manifest.reproductions.length,
    evidenceCount: archive.manifest.evidence.length,
    manifestSha256: archive.manifestSha256,
    restored,
    tenantId: archive.manifest.tenant.tenantId,
  };
}

export class PostgresTenantBackupService {
  constructor(
    private readonly database: PostgresDatabase,
    private readonly blobs: PrivateBlobClient,
    private readonly clock: { now(): Date },
    private readonly logger: TenantBackupLogger,
  ) {}

  async exportTenant(tenantId: string): Promise<TenantBackupArchive> {
    try {
      const archive = await this.buildArchive(
        tenantId,
        this.clock.now().toISOString(),
      );
      this.emit("tenant-backup.exported", "BACKUP_EXPORTED", archive);
      return archive;
    } catch (error) {
      if (error instanceof TenantBackupError) throw error;
      throw backupError(
        "TENANT_BACKUP_FAILED",
        "The tenant backup could not be created",
        true,
      );
    }
  }

  async restoreTenant(input: {
    archive: TenantBackupArchive;
    requestedBy: string;
  }): Promise<TenantRestoreResult> {
    const archive = verifyTenantBackupArchive(input.archive);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.requestedBy)) {
      throw backupError(
        "TENANT_RESTORE_FAILED",
        "The restore requester identity is invalid",
      );
    }

    let existing: RestoreRow | null;
    try {
      existing = await this.findRestore(archive.manifest.tenant.tenantId);
    } catch {
      throw backupError(
        "TENANT_RESTORE_FAILED",
        "The tenant restore target could not be inspected",
        true,
      );
    }
    if (existing) {
      if (
        existing.backup_sha256 === archive.manifestSha256 &&
        (existing.state === "RESTORED" || existing.state === "VERIFIED")
      ) {
        await this.verifyRestore(archive);
        return summary(archive, false);
      }
      throw backupError(
        "TENANT_RESTORE_TARGET_EXISTS",
        "The tenant restore target already contains different state",
      );
    }

    const uploaded = await this.uploadObjects(archive);
    const restoredAt = this.clock.now().toISOString();
    let restored = false;
    try {
      restored = await runSerializableTransaction(
        this.database,
        async (executor) =>
          this.restoreTransaction(
            executor,
            archive,
            input.requestedBy,
            uploaded,
            restoredAt,
          ),
      );
    } catch (error) {
      await this.cleanupUnreferenced(uploaded);
      if (error instanceof TenantBackupError) throw error;
      throw backupError(
        "TENANT_RESTORE_FAILED",
        "The tenant restore transaction failed",
        true,
      );
    }

    if (restored) {
      this.emit("tenant-backup.restored", "RESTORE_COMPLETED", archive);
    }
    await this.verifyRestore(archive);
    return summary(archive, restored);
  }

  async verifyRestore(rawArchive: TenantBackupArchive): Promise<TenantRestoreResult> {
    const archive = verifyTenantBackupArchive(rawArchive);
    try {
      const session = await this.findRestore(archive.manifest.tenant.tenantId);
      if (
        !session ||
        session.backup_sha256 !== archive.manifestSha256 ||
        (session.state !== "RESTORED" && session.state !== "VERIFIED")
      ) {
        throw backupError(
          "TENANT_RESTORE_VERIFICATION_FAILED",
          "The tenant restore ledger does not match the backup",
        );
      }
      const rebuilt = await this.buildArchive(
        archive.manifest.tenant.tenantId,
        archive.manifest.createdAt,
      );
      if (rebuilt.manifestSha256 !== archive.manifestSha256) {
        throw backupError(
          "TENANT_RESTORE_VERIFICATION_FAILED",
          "The restored tenant does not match the backup manifest",
        );
      }
      await this.database.query(
        `UPDATE tenant_restore_sessions
            SET state = 'VERIFIED',
                verified_at = greatest($3::timestamptz, completed_at)
          WHERE tenant_id = $1 AND backup_sha256 = $2
            AND state IN ('RESTORED', 'VERIFIED')`,
        [
          archive.manifest.tenant.tenantId,
          archive.manifestSha256,
          this.clock.now().toISOString(),
        ],
      );
      this.emit("tenant-backup.verified", "RESTORE_VERIFIED", archive);
      return summary(archive, false);
    } catch (error) {
      if (
        error instanceof TenantBackupError &&
        error.code === "TENANT_RESTORE_VERIFICATION_FAILED"
      ) {
        throw error;
      }
      throw backupError(
        "TENANT_RESTORE_VERIFICATION_FAILED",
        "The restored tenant could not be verified",
        true,
      );
    }
  }

  private async buildArchive(
    tenantId: string,
    createdAt: string,
  ): Promise<TenantBackupArchive> {
    const tenantResult = await this.database.query<TenantRow>(
      `SELECT id, status, created_at, updated_at, retention_until
         FROM tenants WHERE id = $1`,
      [tenantId],
    );
    const tenant = tenantResult.rows[0];
    if (!tenant) {
      throw backupError(
        "TENANT_BACKUP_NOT_FOUND",
        "The tenant backup source was not found",
      );
    }
    if (tenant.status !== "ACTIVE") {
      throw backupError(
        "TENANT_BACKUP_NOT_QUIESCENT",
        "The tenant must be active and quiescent before export",
      );
    }

    const counts = await this.database.query<{
      artifacts: number | string;
      available_artifacts: number | string;
      cases: number | string;
      idempotency_keys: number | string;
      jobs: number | string;
      nonterminal_cases: number | string;
      nonterminal_jobs: number | string;
    }>(
      `SELECT
         (SELECT count(*) FROM cases WHERE tenant_id = $1 AND deleted_at IS NULL) AS cases,
         (SELECT count(*) FROM jobs WHERE tenant_id = $1) AS jobs,
         (SELECT count(*) FROM idempotency_keys WHERE tenant_id = $1) AS idempotency_keys,
         (SELECT count(*) FROM artifacts WHERE tenant_id = $1) AS artifacts,
         (SELECT count(*) FROM artifacts WHERE tenant_id = $1 AND status = 'AVAILABLE') AS available_artifacts,
         (SELECT count(*) FROM cases WHERE tenant_id = $1 AND deleted_at IS NULL
            AND state NOT IN ('VERIFIED', 'UNSTABLE', 'NOT_REPRODUCED', 'BLOCKED', 'CANCELLED')) AS nonterminal_cases,
         (SELECT count(*) FROM jobs WHERE tenant_id = $1
            AND state NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED')) AS nonterminal_jobs`,
      [tenantId],
    );
    const count = counts.rows[0];
    if (
      !count ||
      integer(count.cases) !== integer(count.jobs) ||
      integer(count.cases) !== integer(count.idempotency_keys) ||
      integer(count.artifacts) !== integer(count.available_artifacts) ||
      integer(count.nonterminal_cases) !== 0 ||
      integer(count.nonterminal_jobs) !== 0
    ) {
      throw backupError(
        "TENANT_BACKUP_NOT_QUIESCENT",
        "The tenant backup requires terminal one-to-one reproduction state and available artifacts",
      );
    }

    const reproductionRows = await this.database.query<ReproductionRow>(
      `SELECT
         i.tenant_id, i.caller_id, i.idempotency_key,
         trim(i.command_hash) AS command_hash,
         i.created_at AS idempotency_created_at,
         i.expires_at AS idempotency_expires_at,
         c.id AS case_id, c.source_kind, c.source_descriptor,
         c.state AS case_state, c.domain_state AS case_domain_state,
         c.version AS case_version, c.created_at AS case_created_at,
         c.updated_at AS case_updated_at,
         c.retention_until AS case_retention_until,
         j.id AS job_id, j.state AS job_state,
         j.progress_phase AS job_progress_phase, j.attempt AS job_attempt,
         j.max_attempts AS job_max_attempts,
         j.next_attempt_at AS job_next_attempt_at,
         j.cancellation_requested_at, j.cancelled_at,
         j.failure_code AS job_failure_code,
         j.failure_message AS job_failure_message,
         j.failure_retryable AS job_failure_retryable,
         j.version AS job_version, j.created_at AS job_created_at,
         j.updated_at AS job_updated_at,
         j.retention_until AS job_retention_until
       FROM idempotency_keys i
       JOIN cases c
         ON c.tenant_id = i.tenant_id AND c.id = i.case_id
       JOIN jobs j
         ON j.tenant_id = i.tenant_id
        AND j.case_id = i.case_id AND j.id = i.job_id
      WHERE i.tenant_id = $1
      ORDER BY c.id, j.id, i.caller_id, i.idempotency_key`,
      [tenantId],
    );
    const reproductions = reproductionRows.rows.map((row) =>
      this.mapReproduction(row),
    );

    const evidenceResult = await this.database.query<EvidenceRow>(
      `SELECT tenant_id, case_id, job_id, attempt, sequence, kind,
              trim(command_hash) AS command_hash, exit_code, passed,
              duration_ms, environment, evidence, lease_owner,
              created_at, retention_until
         FROM run_evidence
        WHERE tenant_id = $1
        ORDER BY job_id, attempt, sequence`,
      [tenantId],
    );
    const evidence = evidenceResult.rows.map((row) => this.mapEvidence(row));

    const artifactResult = await this.database.query<ArtifactRow>(
      `SELECT tenant_id, id, case_id, kind, trim(sha256) AS sha256,
              byte_count, object_key, provider_etag,
              created_at, retention_until
         FROM artifacts
        WHERE tenant_id = $1 AND status = 'AVAILABLE'
        ORDER BY case_id, kind, id`,
      [tenantId],
    );
    const artifacts = artifactResult.rows.map((row) =>
      artifactDescriptorSchema.parse({
        artifactId: row.id,
        byteCount: integer(row.byte_count),
        caseId: row.case_id,
        createdAt: timestamp(row.created_at),
        kind: row.kind,
        objectKey: row.object_key,
        retentionUntil: timestamp(row.retention_until),
        sha256: row.sha256.trim(),
        tenantId: row.tenant_id,
      }),
    );
    const objects: Record<string, Uint8Array> = {};
    for (const [index, artifact] of artifacts.entries()) {
      const row = artifactResult.rows[index];
      if (!row) {
        throw backupError(
          "TENANT_BACKUP_CORRUPT",
          "The artifact manifest is incomplete",
        );
      }
      let stored;
      try {
        stored = await this.blobs.get(artifact.objectKey);
      } catch {
        throw backupError(
          "TENANT_BACKUP_PROVIDER_UNAVAILABLE",
          "The private artifact provider is unavailable during backup",
          true,
        );
      }
      if (
        !stored ||
        stored.metadata.pathname !== artifact.objectKey ||
        stored.metadata.size !== artifact.byteCount ||
        stored.metadata.etag !== row.provider_etag
      ) {
        throw backupError(
          "TENANT_BACKUP_CORRUPT",
          "The private artifact metadata does not match durable state",
        );
      }
      objects[artifact.objectKey] = stored.bytes;
    }

    let manifest: TenantBackupManifest;
    try {
      manifest = tenantBackupManifestSchema.parse({
        artifacts,
        createdAt,
        evidence,
        reproductions,
        schemaVersion: "1.0",
        tenant: {
          createdAt: timestamp(tenant.created_at),
          retentionUntil: nullableTimestamp(tenant.retention_until),
          status: tenant.status,
          tenantId: tenant.id,
          updatedAt: timestamp(tenant.updated_at),
        },
      });
    } catch {
      throw backupError(
        "TENANT_BACKUP_CORRUPT",
        "The durable tenant state cannot form a canonical backup manifest",
      );
    }
    return sealTenantBackupArchive(manifest, objects);
  }

  private mapReproduction(row: ReproductionRow): TenantBackupReproduction {
    const domain = objectValue(row.case_domain_state);
    const caseVersion = integer(row.case_version);
    const jobVersion = integer(row.job_version);
    if (caseVersion === null || caseVersion !== jobVersion) {
      throw backupError(
        "TENANT_BACKUP_CORRUPT",
        "The durable case and job versions do not agree",
      );
    }
    const failure =
      row.job_failure_code === null &&
      row.job_failure_message === null &&
      row.job_failure_retryable === null
        ? null
        : {
            code: row.job_failure_code,
            message: row.job_failure_message,
            retryable: row.job_failure_retryable,
          };
    let snapshot;
    try {
      snapshot = reproductionSnapshotSchema.parse({
        ...domain,
        job: {
          attempt: integer(row.job_attempt),
          caseId: row.case_id,
          createdAt: timestamp(row.job_created_at),
          failure,
          id: row.job_id,
          progressPhase: row.job_progress_phase,
          state: row.job_state,
          updatedAt: timestamp(row.job_updated_at),
        },
      });
    } catch {
      throw backupError(
        "TENANT_BACKUP_CORRUPT",
        "The stored reproduction snapshot is invalid",
      );
    }
    return {
      cancellation: {
        cancelledAt: nullableTimestamp(row.cancelled_at),
        requestedAt: nullableTimestamp(row.cancellation_requested_at),
      },
      caseRetentionUntil: timestamp(row.case_retention_until),
      idempotencyCreatedAt: timestamp(row.idempotency_created_at),
      idempotencyExpiresAt: timestamp(row.idempotency_expires_at),
      jobMaxAttempts: integer(row.job_max_attempts) as number,
      jobNextAttemptAt: timestamp(row.job_next_attempt_at),
      jobRetentionUntil: timestamp(row.job_retention_until),
      record: {
        callerId: row.caller_id,
        caseId: row.case_id,
        commandHash: row.command_hash.trim(),
        createdAt: timestamp(row.case_created_at),
        idempotencyKey: row.idempotency_key,
        jobId: row.job_id,
        snapshot,
        tenantId: row.tenant_id,
        updatedAt: timestamp(row.case_updated_at),
        version: caseVersion,
      },
      sourceDescriptor: objectValue(row.source_descriptor),
      sourceKind: row.source_kind,
    };
  }

  private mapEvidence(row: EvidenceRow): TenantBackupEvidence {
    return {
      attempt: integer(row.attempt) as number,
      caseId: row.case_id,
      commandHash: row.command_hash?.trim() ?? null,
      createdAt: timestamp(row.created_at),
      durationMs: integer(row.duration_ms),
      environment: objectValue(row.environment),
      evidence: objectValue(row.evidence),
      exitCode: integer(row.exit_code),
      jobId: row.job_id,
      kind: row.kind,
      leaseOwner: row.lease_owner,
      passed: row.passed,
      retentionUntil: timestamp(row.retention_until),
      sequence: integer(row.sequence) as number,
      tenantId: row.tenant_id,
    };
  }

  private async findRestore(tenantId: string): Promise<RestoreRow | null> {
    const result = await this.database.query<RestoreRow>(
      `SELECT t.id AS tenant_id, r.backup_sha256, r.state
         FROM tenants t
         LEFT JOIN tenant_restore_sessions r ON r.tenant_id = t.id
        WHERE t.id = $1`,
      [tenantId],
    );
    return result.rows[0] ?? null;
  }

  private async uploadObjects(
    archive: TenantBackupArchive,
  ): Promise<Map<string, { created: boolean; metadata: PrivateBlobMetadata }>> {
    const uploaded = new Map<
      string,
      { created: boolean; metadata: PrivateBlobMetadata }
    >();
    try {
      for (const artifact of archive.manifest.artifacts) {
        const bytes = archive.objects[artifact.objectKey];
        if (!bytes) {
          throw backupError(
            "TENANT_BACKUP_CORRUPT",
            "The backup object body is missing",
          );
        }
        let metadata: PrivateBlobMetadata;
        let created = false;
        try {
          metadata = await this.blobs.put(artifact.objectKey, bytes);
          created = true;
        } catch {
          const existing = await this.blobs.get(artifact.objectKey).catch(() => null);
          if (!existing) {
            throw backupError(
              "TENANT_BACKUP_PROVIDER_UNAVAILABLE",
              "The private artifact provider is unavailable during restore",
              true,
            );
          }
          metadata = existing.metadata;
          if (
            existing.bytes.byteLength !== artifact.byteCount ||
            !existing.bytes.every((byte, index) => byte === bytes[index])
          ) {
            throw backupError(
              "TENANT_BACKUP_CORRUPT",
              "An existing private object conflicts with the backup",
            );
          }
        }
        if (
          metadata.pathname !== artifact.objectKey ||
          metadata.size !== artifact.byteCount
        ) {
          if (created) {
            await this.blobs.delete(artifact.objectKey, metadata.etag).catch(() => false);
          }
          throw backupError(
            "TENANT_BACKUP_CORRUPT",
            "The restored private object metadata is invalid",
          );
        }
        uploaded.set(artifact.objectKey, { created, metadata });
      }
      return uploaded;
    } catch (error) {
      await Promise.all(
        [...uploaded.entries()]
          .filter(([, value]) => value.created)
          .map(([objectKey, value]) =>
            this.blobs.delete(objectKey, value.metadata.etag).catch(() => false),
          ),
      );
      throw error;
    }
  }

  private async restoreTransaction(
    executor: PostgresExecutor,
    archive: TenantBackupArchive,
    requestedBy: string,
    uploaded: Map<string, { created: boolean; metadata: PrivateBlobMetadata }>,
    restoredAt: string,
  ): Promise<boolean> {
    const { manifest } = archive;
    const tenantId = manifest.tenant.tenantId;
    await executor.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `tenant-restore:${tenantId}`,
    ]);
    const existing = await executor.query<RestoreRow>(
      `SELECT t.id AS tenant_id, r.backup_sha256, r.state
         FROM tenants t
         LEFT JOIN tenant_restore_sessions r ON r.tenant_id = t.id
        WHERE t.id = $1`,
      [tenantId],
    );
    const existingRow = existing.rows[0];
    if (existingRow) {
      if (
        existingRow.backup_sha256 === archive.manifestSha256 &&
        (existingRow.state === "RESTORED" || existingRow.state === "VERIFIED")
      ) {
        return false;
      }
      throw backupError(
        "TENANT_RESTORE_TARGET_EXISTS",
        "The tenant restore target already contains different state",
      );
    }

    await executor.query(
      `INSERT INTO tenants (
         id, status, created_at, updated_at, retention_until
       ) VALUES ($1, 'ACTIVE', $2, $3, $4)`,
      [
        tenantId,
        manifest.tenant.createdAt,
        manifest.tenant.updatedAt,
        manifest.tenant.retentionUntil,
      ],
    );
    await executor.query(
      `INSERT INTO tenant_restore_sessions (
         tenant_id, backup_sha256, requested_by, manifest_schema_version,
         state, case_count, evidence_count, artifact_count, byte_count,
         started_at
       ) VALUES ($1, $2, $3, '1.0', 'RUNNING', $4, $5, $6, $7, $8)`,
      [
        tenantId,
        archive.manifestSha256,
        requestedBy,
        manifest.reproductions.length,
        manifest.evidence.length,
        manifest.artifacts.length,
        backupArtifactByteCount(manifest.artifacts),
        restoredAt,
      ],
    );

    for (const reproduction of manifest.reproductions) {
      const { record } = reproduction;
      const domainState = {
        case: record.snapshot.case,
        result: record.snapshot.result,
        sampleId: record.snapshot.sampleId,
        schemaVersion: record.snapshot.schemaVersion,
      };
      await executor.query(
        `INSERT INTO cases (
           tenant_id, id, source_kind, source_descriptor, state, domain_state,
           schema_version, version, created_at, updated_at, retention_until
         ) VALUES (
           $1, $2, $3, $4::jsonb, $5, $6::jsonb,
           $7, $8, $9, $10, $11
         )`,
        [
          tenantId,
          record.caseId,
          reproduction.sourceKind,
          JSON.stringify(reproduction.sourceDescriptor),
          record.snapshot.case.state,
          JSON.stringify(domainState),
          record.snapshot.schemaVersion,
          record.version,
          record.createdAt,
          record.updatedAt,
          reproduction.caseRetentionUntil,
        ],
      );
      const failure = record.snapshot.job.failure;
      await executor.query(
        `INSERT INTO jobs (
           tenant_id, id, case_id, state, progress_phase, attempt,
           max_attempts, next_attempt_at,
           cancellation_requested_at, cancelled_at,
           failure_code, failure_message, failure_retryable,
           version, created_at, updated_at, retention_until
         ) VALUES (
           $1, $2, $3, $4, $5, $6,
           $7, $8, $9, $10, $11, $12, $13,
           $14, $15, $16, $17
         )`,
        [
          tenantId,
          record.jobId,
          record.caseId,
          record.snapshot.job.state,
          record.snapshot.job.progressPhase,
          record.snapshot.job.attempt,
          reproduction.jobMaxAttempts,
          reproduction.jobNextAttemptAt,
          reproduction.cancellation.requestedAt,
          reproduction.cancellation.cancelledAt,
          failure?.code ?? null,
          failure?.message ?? null,
          failure?.retryable ?? null,
          record.version,
          record.snapshot.job.createdAt,
          record.snapshot.job.updatedAt,
          reproduction.jobRetentionUntil,
        ],
      );
      await executor.query(
        `INSERT INTO idempotency_keys (
           tenant_id, caller_id, idempotency_key, command_hash,
           case_id, job_id, created_at, expires_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          tenantId,
          record.callerId,
          record.idempotencyKey,
          record.commandHash,
          record.caseId,
          record.jobId,
          reproduction.idempotencyCreatedAt,
          reproduction.idempotencyExpiresAt,
        ],
      );
    }

    for (const evidence of manifest.evidence) {
      await executor.query(
        `INSERT INTO run_evidence (
           tenant_id, case_id, job_id, attempt, sequence, kind,
           command_hash, exit_code, passed, duration_ms,
           environment, evidence, lease_owner, created_at, retention_until
         ) VALUES (
           $1, $2, $3, $4, $5, $6,
           $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13, $14, $15
         )`,
        [
          tenantId,
          evidence.caseId,
          evidence.jobId,
          evidence.attempt,
          evidence.sequence,
          evidence.kind,
          evidence.commandHash,
          evidence.exitCode,
          evidence.passed,
          evidence.durationMs,
          JSON.stringify(evidence.environment),
          JSON.stringify(evidence.evidence),
          evidence.leaseOwner,
          evidence.createdAt,
          evidence.retentionUntil,
        ],
      );
    }

    for (const artifact of manifest.artifacts) {
      const metadata = uploaded.get(artifact.objectKey)?.metadata;
      if (!metadata) {
        throw backupError(
          "TENANT_RESTORE_FAILED",
          "The restored private object metadata is unavailable",
        );
      }
      const verifiedAt = new Date(
        Math.max(Date.parse(restoredAt), Date.parse(artifact.createdAt)),
      ).toISOString();
      await executor.query(
        `INSERT INTO artifacts (
           tenant_id, id, case_id, kind, sha256, byte_count, object_key,
           access_class, retention_class, created_at, retention_until,
           status, provider_etag, verified_at, version, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7,
           'PRIVATE', $8, $9, $10,
           'AVAILABLE', $11, $12, 1, $12
         )`,
        [
          tenantId,
          artifact.artifactId,
          artifact.caseId,
          artifact.kind,
          artifact.sha256,
          artifact.byteCount,
          artifact.objectKey,
          retentionClass(artifact.kind),
          artifact.createdAt,
          artifact.retentionUntil,
          metadata.etag,
          verifiedAt,
        ],
      );
    }

    const completed = await executor.query<{ tenant_id: string }>(
      `UPDATE tenant_restore_sessions
          SET state = 'RESTORED', completed_at = $3
        WHERE tenant_id = $1 AND backup_sha256 = $2 AND state = 'RUNNING'
        RETURNING tenant_id`,
      [tenantId, archive.manifestSha256, restoredAt],
    );
    if (!completed.rows[0]) {
      throw backupError(
        "TENANT_RESTORE_FAILED",
        "The tenant restore ledger could not be completed",
      );
    }
    return true;
  }

  private async cleanupUnreferenced(
    uploaded: Map<string, { created: boolean; metadata: PrivateBlobMetadata }>,
  ): Promise<void> {
    for (const [objectKey, value] of uploaded.entries()) {
      if (!value.created) continue;
      try {
        const reference = await this.database.query<{ found: boolean }>(
          "SELECT true AS found FROM artifacts WHERE object_key = $1 LIMIT 1",
          [objectKey],
        );
        if (!reference.rows[0]?.found) {
          await this.blobs.delete(objectKey, value.metadata.etag);
        }
      } catch {
        // Preserve a possible referenced object rather than risking data loss.
      }
    }
  }

  private emit(
    event:
      | "tenant-backup.exported"
      | "tenant-backup.restored"
      | "tenant-backup.verified",
    code: string,
    archive: TenantBackupArchive,
  ): void {
    this.logger.emit({
      artifactCount: archive.manifest.artifacts.length,
      at: this.clock.now().toISOString(),
      byteCount: backupArtifactByteCount(archive.manifest.artifacts),
      caseCount: archive.manifest.reproductions.length,
      code,
      event,
      evidenceCount: archive.manifest.evidence.length,
      level: "info",
      manifestSha256: archive.manifestSha256,
      outcome: "success",
      tenantId: archive.manifest.tenant.tenantId,
    });
  }
}
