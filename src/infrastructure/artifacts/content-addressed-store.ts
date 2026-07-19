import { createHash } from "node:crypto";

import {
  artifactDescriptorSchema,
  tenantScopeSchema,
  type ArtifactDescriptor,
  type ArtifactStore,
  type TenantScope,
} from "@/application/ports/production";
import {
  runSerializableTransaction,
  type PostgresDatabase,
} from "@/infrastructure/postgres/database";

import type {
  PrivateBlobClient,
  PrivateBlobMetadata,
} from "./private-blob-client";

type ArtifactRow = {
  byte_count: number | string;
  case_id: string;
  created_at: Date | string;
  id: string;
  kind: ArtifactDescriptor["kind"];
  object_key: string;
  provider_etag: string | null;
  retention_until: Date | string;
  sha256: string;
  status: "AVAILABLE" | "DELETED" | "DELETING" | "FAILED" | "PENDING";
  tenant_id: string;
  version: number | string;
};

export class ArtifactStoreError extends Error {
  constructor(
    readonly code:
      | "ARTIFACT_INTEGRITY_MISMATCH"
      | "ARTIFACT_PENDING"
      | "ARTIFACT_PROVIDER_UNAVAILABLE"
      | "ARTIFACT_TENANT_UNAVAILABLE",
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ArtifactStoreError";
  }
}

export class ArtifactIntegrityError extends ArtifactStoreError {
  constructor() {
    super(
      "ARTIFACT_INTEGRITY_MISMATCH",
      "The artifact did not match its canonical identity",
      false,
    );
    this.name = "ArtifactIntegrityError";
  }
}

export class ArtifactPendingError extends ArtifactStoreError {
  constructor() {
    super("ARTIFACT_PENDING", "The artifact write is still pending", true);
    this.name = "ArtifactPendingError";
  }
}

export class ArtifactProviderError extends ArtifactStoreError {
  constructor() {
    super(
      "ARTIFACT_PROVIDER_UNAVAILABLE",
      "The private artifact provider is unavailable",
      true,
    );
    this.name = "ArtifactProviderError";
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function timestamp(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new ArtifactIntegrityError();
  return parsed.toISOString();
}

function integer(value: number | string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ArtifactIntegrityError();
  }
  return parsed;
}

function rowDescriptor(row: ArtifactRow): ArtifactDescriptor {
  try {
    return artifactDescriptorSchema.parse({
      artifactId: row.id,
      byteCount: integer(row.byte_count),
      caseId: row.case_id,
      createdAt: timestamp(row.created_at),
      kind: row.kind,
      objectKey: row.object_key,
      retentionUntil: timestamp(row.retention_until),
      sha256: row.sha256.trim(),
      tenantId: row.tenant_id,
    });
  } catch (error) {
    if (error instanceof ArtifactIntegrityError) throw error;
    throw new ArtifactIntegrityError();
  }
}

function validatePut(input: {
  bytes: Uint8Array;
  descriptor: ArtifactDescriptor;
}): { bytes: Uint8Array; descriptor: ArtifactDescriptor } {
  let descriptor: ArtifactDescriptor;
  try {
    descriptor = artifactDescriptorSchema.parse(input.descriptor);
  } catch {
    throw new ArtifactIntegrityError();
  }
  if (
    descriptor.byteCount !== input.bytes.byteLength ||
    descriptor.sha256 !== sha256(input.bytes)
  ) {
    throw new ArtifactIntegrityError();
  }
  return { bytes: Uint8Array.from(input.bytes), descriptor };
}

function metadataMatches(
  descriptor: ArtifactDescriptor,
  etag: string | null,
  metadata: PrivateBlobMetadata | null,
): metadata is PrivateBlobMetadata {
  return Boolean(
    metadata &&
      metadata.pathname === descriptor.objectKey &&
      metadata.size === descriptor.byteCount &&
      (etag === null || metadata.etag === etag),
  );
}

export class ContentAddressedArtifactStore implements ArtifactStore {
  constructor(
    private readonly database: PostgresDatabase,
    private readonly blobs: PrivateBlobClient,
    private readonly clock: { now(): Date },
  ) {}

  async put(rawInput: {
    bytes: Uint8Array;
    descriptor: ArtifactDescriptor;
  }): Promise<ArtifactDescriptor> {
    const input = validatePut(rawInput);
    const inserted = await runSerializableTransaction(
      this.database,
      async (executor) => {
        const tenant = await executor.query<{ status: string }>(
          "SELECT status FROM tenants WHERE id = $1 FOR UPDATE",
          [input.descriptor.tenantId],
        );
        if (tenant.rows[0]?.status !== "ACTIVE") {
          throw new ArtifactStoreError(
            "ARTIFACT_TENANT_UNAVAILABLE",
            "The tenant cannot accept artifact writes",
            false,
          );
        }
        return executor.query<ArtifactRow>(
          `INSERT INTO artifacts (
             tenant_id, id, case_id, kind, sha256, byte_count, object_key,
             access_class, retention_class, created_at, retention_until,
             status, version, updated_at
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7,
             'PRIVATE', $8, $9, $10, 'PENDING', 1, $9
           )
           ON CONFLICT (tenant_id, case_id, kind, sha256) DO NOTHING
           RETURNING *`,
          [
            input.descriptor.tenantId,
            input.descriptor.artifactId,
            input.descriptor.caseId,
            input.descriptor.kind,
            input.descriptor.sha256,
            input.descriptor.byteCount,
            input.descriptor.objectKey,
            this.retentionClass(input.descriptor.kind),
            input.descriptor.createdAt,
            input.descriptor.retentionUntil,
          ],
        );
      },
    );

    let row: ArtifactRow | null | undefined = inserted.rows[0];
    let ownsPendingWrite = row !== undefined;
    if (!row) {
      row = await this.findByIdentity(input.descriptor);
      if (!row) throw new ArtifactProviderError();
      if (row.status === "AVAILABLE") {
        await this.verifyAvailableMetadata(row);
        return rowDescriptor(row);
      }
      if (row.status === "FAILED") {
        const reclaimed = await this.database.query<ArtifactRow>(
          `UPDATE artifacts
              SET status = 'PENDING', failure_code = NULL,
                  version = version + 1, updated_at = $6
            WHERE tenant_id = $1 AND case_id = $2 AND kind = $3
              AND sha256 = $4 AND status = 'FAILED' AND version = $5
            RETURNING *`,
          [
            row.tenant_id,
            row.case_id,
            row.kind,
            row.sha256.trim(),
            integer(row.version),
            this.clock.now().toISOString(),
          ],
        );
        row = reclaimed.rows[0];
        ownsPendingWrite = row !== undefined;
      }
      if (!ownsPendingWrite || !row || row.status !== "PENDING") {
        throw new ArtifactPendingError();
      }
    }

    const storedDescriptor = rowDescriptor(row);
    let providerMetadata: PrivateBlobMetadata | undefined;
    try {
      try {
        providerMetadata = await this.blobs.put(
          storedDescriptor.objectKey,
          input.bytes,
        );
      } catch {
        const orphan = await this.blobs.get(storedDescriptor.objectKey);
        if (
          !orphan ||
          orphan.bytes.byteLength !== storedDescriptor.byteCount ||
          sha256(orphan.bytes) !== storedDescriptor.sha256
        ) {
          throw new ArtifactProviderError();
        }
        providerMetadata = orphan.metadata;
      }
      if (!metadataMatches(storedDescriptor, null, providerMetadata)) {
        throw new ArtifactIntegrityError();
      }
      const finalized = await this.database.query<ArtifactRow>(
        `UPDATE artifacts
            SET status = 'AVAILABLE', provider_etag = $4, verified_at = $5,
                version = version + 1, updated_at = $5
          WHERE tenant_id = $1 AND id = $2 AND status = 'PENDING' AND version = $3
          RETURNING *`,
        [
          storedDescriptor.tenantId,
          storedDescriptor.artifactId,
          integer(row.version),
          providerMetadata.etag,
          this.clock.now().toISOString(),
        ],
      );
      const available = finalized.rows[0];
      if (!available) throw new ArtifactPendingError();
      return rowDescriptor(available);
    } catch (error) {
      await this.blobs
        .delete(storedDescriptor.objectKey, providerMetadata?.etag)
        .catch(() => false);
      await this.database.query(
        `UPDATE artifacts
            SET status = 'FAILED', provider_etag = NULL, verified_at = NULL,
                failure_code = $4, version = version + 1, updated_at = $5
          WHERE tenant_id = $1 AND id = $2 AND status = 'PENDING' AND version = $3`,
        [
          storedDescriptor.tenantId,
          storedDescriptor.artifactId,
          integer(row.version),
          error instanceof ArtifactIntegrityError
            ? "ARTIFACT_PROVIDER_MISMATCH"
            : "ARTIFACT_PROVIDER_FAILURE",
          this.clock.now().toISOString(),
        ],
      );
      if (error instanceof ArtifactStoreError) throw error;
      throw new ArtifactProviderError();
    }
  }

  async read(
    rawScope: TenantScope,
    artifactId: string,
  ): Promise<{ bytes: Uint8Array; descriptor: ArtifactDescriptor } | null> {
    const scope = tenantScopeSchema.parse(rawScope);
    const row = await this.findAuthorized(scope, artifactId, "AVAILABLE");
    if (!row) return null;
    const descriptor = rowDescriptor(row);
    const stored = await this.blobs.get(descriptor.objectKey);
    if (
      !stored ||
      !metadataMatches(descriptor, row.provider_etag, stored.metadata) ||
      stored.bytes.byteLength !== descriptor.byteCount ||
      sha256(stored.bytes) !== descriptor.sha256
    ) {
      throw new ArtifactIntegrityError();
    }
    return { bytes: stored.bytes, descriptor };
  }

  async delete(rawScope: TenantScope, artifactId: string): Promise<boolean> {
    const scope = tenantScopeSchema.parse(rawScope);
    const row = await this.findAuthorized(scope, artifactId, "AVAILABLE");
    if (!row || !row.provider_etag) return false;
    const descriptor = rowDescriptor(row);
    const deleting = await this.database.query<ArtifactRow>(
      `UPDATE artifacts
          SET status = 'DELETING', version = version + 1, updated_at = $4
        WHERE tenant_id = $1 AND id = $2 AND status = 'AVAILABLE' AND version = $3
        RETURNING *`,
      [
        descriptor.tenantId,
        descriptor.artifactId,
        integer(row.version),
        this.clock.now().toISOString(),
      ],
    );
    const claimed = deleting.rows[0];
    if (!claimed) return false;

    try {
      const deleted = await this.blobs.delete(
        descriptor.objectKey,
        row.provider_etag,
      );
      if (!deleted && (await this.blobs.head(descriptor.objectKey))) {
        throw new ArtifactProviderError();
      }
      const completed = await this.database.query<{ id: string }>(
        `UPDATE artifacts
            SET status = 'DELETED', deleted_at = $4,
                version = version + 1, updated_at = $4
          WHERE tenant_id = $1 AND id = $2 AND status = 'DELETING' AND version = $3
          RETURNING id`,
        [
          descriptor.tenantId,
          descriptor.artifactId,
          integer(claimed.version),
          this.clock.now().toISOString(),
        ],
      );
      if (!completed.rows[0]) throw new ArtifactProviderError();
      return true;
    } catch (error) {
      await this.database.query(
        `UPDATE artifacts
            SET status = 'AVAILABLE', version = version + 1, updated_at = $4
          WHERE tenant_id = $1 AND id = $2 AND status = 'DELETING' AND version = $3`,
        [
          descriptor.tenantId,
          descriptor.artifactId,
          integer(claimed.version),
          this.clock.now().toISOString(),
        ],
      );
      if (error instanceof ArtifactStoreError) throw error;
      throw new ArtifactProviderError();
    }
  }

  private async findByIdentity(
    descriptor: ArtifactDescriptor,
  ): Promise<ArtifactRow | null> {
    const result = await this.database.query<ArtifactRow>(
      `SELECT * FROM artifacts
        WHERE tenant_id = $1 AND case_id = $2 AND kind = $3 AND sha256 = $4
        LIMIT 1`,
      [
        descriptor.tenantId,
        descriptor.caseId,
        descriptor.kind,
        descriptor.sha256,
      ],
    );
    return result.rows[0] ?? null;
  }

  private async findAuthorized(
    scope: TenantScope,
    artifactId: string,
    status: ArtifactRow["status"],
  ): Promise<ArtifactRow | null> {
    const result = await this.database.query<ArtifactRow>(
      `SELECT a.*
         FROM artifacts a
        WHERE a.tenant_id = $1 AND a.id = $2 AND a.status = $3
          AND EXISTS (
            SELECT 1 FROM idempotency_keys i
             WHERE i.tenant_id = a.tenant_id AND i.case_id = a.case_id
               AND i.caller_id = $4
          )
        LIMIT 1`,
      [scope.tenantId, artifactId, status, scope.callerId],
    );
    return result.rows[0] ?? null;
  }

  private async verifyAvailableMetadata(row: ArtifactRow): Promise<void> {
    const descriptor = rowDescriptor(row);
    const metadata = await this.blobs.head(descriptor.objectKey);
    if (!metadataMatches(descriptor, row.provider_etag, metadata)) {
      throw new ArtifactIntegrityError();
    }
  }

  private retentionClass(
    kind: ArtifactDescriptor["kind"],
  ): "backup" | "bundle" | "run" | "source" {
    if (kind === "backup-manifest") return "backup";
    if (kind === "bundle") return "bundle";
    if (kind === "source") return "source";
    return "run";
  }
}
