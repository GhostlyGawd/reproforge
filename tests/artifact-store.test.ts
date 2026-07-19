import { createHash } from "node:crypto";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type {
  ArtifactDescriptor,
  DurableReproductionRecord,
  TenantScope,
} from "@/application/ports/production";
import { createCase } from "@/domain/case";
import { createJob } from "@/domain/job";
import {
  ArtifactIntegrityError,
  ContentAddressedArtifactStore,
} from "@/infrastructure/artifacts/content-addressed-store";
import { applyPostgresMigrations } from "@/infrastructure/postgres/migrations";
import { PostgresDurableReproductionRepository } from "@/infrastructure/postgres/repositories";

import { MemoryPrivateBlobClient } from "./helpers/memory-private-blob-client";
import { pgliteMigrationClient } from "./helpers/pglite-migration-client";
import { pglitePostgresDatabase } from "./helpers/pglite-postgres-database";

vi.setConfig({ hookTimeout: 30_000, testTimeout: 30_000 });

const AT = "2026-07-19T20:00:00.000Z";
const RETENTION = "2026-08-19T20:00:00.000Z";

let database: PGlite;
let postgres: ReturnType<typeof pglitePostgresDatabase>;

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function scope(tenantId: string, callerId: string): TenantScope {
  return { callerId, principalId: callerId, tenantId };
}

async function seedCase(
  tenantId: string,
  callerId = `caller_${tenantId}`,
): Promise<DurableReproductionRecord> {
  const caseId = `case_${tenantId}`;
  const jobId = `job_${tenantId}`;
  const at = new Date(AT);
  await database.query("INSERT INTO tenants (id) VALUES ($1)", [tenantId]);
  const value: DurableReproductionRecord = {
    callerId,
    caseId,
    commandHash: "a".repeat(64),
    createdAt: AT,
    idempotencyKey: "artifact_case",
    jobId,
    snapshot: {
      case: createCase(caseId, at),
      job: createJob(jobId, caseId, at),
      result: null,
      sampleId: "cli-spaces",
      schemaVersion: "2.0",
    },
    tenantId,
    updatedAt: AT,
    version: 1,
  };
  await new PostgresDurableReproductionRepository(postgres).reserve(value);
  return value;
}

function descriptor(
  record: DurableReproductionRecord,
  bytes: Uint8Array,
  artifactId = `artifact_${record.tenantId}`,
): ArtifactDescriptor {
  const sha256 = digest(bytes);
  return {
    artifactId,
    byteCount: bytes.byteLength,
    caseId: record.caseId,
    createdAt: AT,
    kind: "bundle",
    objectKey: `tenants/${record.tenantId}/cases/${record.caseId}/bundle/${sha256}`,
    retentionUntil: RETENTION,
    sha256,
    tenantId: record.tenantId,
  };
}

beforeAll(async () => {
  database = new PGlite();
  await applyPostgresMigrations(pgliteMigrationClient(database));
  postgres = pglitePostgresDatabase(database);
});

afterAll(async () => {
  await database.close();
});

describe("private content-addressed artifact store", () => {
  it("writes once, verifies metadata, and reuses an identical write", async () => {
    const record = await seedCase("tenant_artifact_dedupe");
    const blobs = new MemoryPrivateBlobClient();
    const store = new ContentAddressedArtifactStore(postgres, blobs, {
      now: () => new Date(AT),
    });
    const bytes = new TextEncoder().encode("portable bundle bytes");
    const expected = descriptor(record, bytes);

    await expect(store.put({ bytes, descriptor: expected })).resolves.toEqual(
      expected,
    );
    await expect(store.put({ bytes, descriptor: expected })).resolves.toEqual(
      expected,
    );
    expect(blobs.puts).toEqual([expected.objectKey]);
    const rows = await database.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM artifacts WHERE tenant_id = $1",
      [record.tenantId],
    );
    expect(rows.rows[0]?.count).toBe("1");
  });

  it("rejects hash and byte-count mismatches before upload", async () => {
    const record = await seedCase("tenant_artifact_mismatch");
    const blobs = new MemoryPrivateBlobClient();
    const store = new ContentAddressedArtifactStore(postgres, blobs, {
      now: () => new Date(AT),
    });
    const bytes = new TextEncoder().encode("trusted bytes");
    const expected = descriptor(record, bytes);

    await expect(
      store.put({
        bytes,
        descriptor: { ...expected, sha256: "b".repeat(64) },
      }),
    ).rejects.toBeInstanceOf(ArtifactIntegrityError);
    await expect(
      store.put({
        bytes,
        descriptor: { ...expected, byteCount: bytes.byteLength + 1 },
      }),
    ).rejects.toBeInstanceOf(ArtifactIntegrityError);
    expect(blobs.puts).toEqual([]);
  });

  it("removes a partial object and records failure when provider metadata differs", async () => {
    const record = await seedCase("tenant_artifact_partial");
    const blobs = new MemoryPrivateBlobClient();
    blobs.reportedSizeDelta = 1;
    const store = new ContentAddressedArtifactStore(postgres, blobs, {
      now: () => new Date(AT),
    });
    const bytes = new TextEncoder().encode("provider mismatch");
    const expected = descriptor(record, bytes);

    await expect(store.put({ bytes, descriptor: expected })).rejects.toBeInstanceOf(
      ArtifactIntegrityError,
    );
    expect(blobs.has(expected.objectKey)).toBe(false);
    const status = await database.query<{ failure_code: string; status: string }>(
      "SELECT status, failure_code FROM artifacts WHERE tenant_id = $1",
      [record.tenantId],
    );
    expect(status.rows).toEqual([
      { failure_code: "ARTIFACT_PROVIDER_MISMATCH", status: "FAILED" },
    ]);
  });

  it("authorizes reads through case ownership and verifies returned bytes", async () => {
    const record = await seedCase("tenant_artifact_read");
    const blobs = new MemoryPrivateBlobClient();
    const store = new ContentAddressedArtifactStore(postgres, blobs, {
      now: () => new Date(AT),
    });
    const bytes = new TextEncoder().encode("read me privately");
    const expected = descriptor(record, bytes);
    await store.put({ bytes, descriptor: expected });

    await expect(
      store.read(scope(record.tenantId, record.callerId), expected.artifactId),
    ).resolves.toEqual({ bytes, descriptor: expected });
    await expect(
      store.read(scope("tenant_someone_else", record.callerId), expected.artifactId),
    ).resolves.toBeNull();
    await expect(
      store.read(scope(record.tenantId, "caller_someone_else"), expected.artifactId),
    ).resolves.toBeNull();
    expect(blobs.gets).toEqual([expected.objectKey]);
  });

  it("fails closed if stored bytes no longer match their canonical digest", async () => {
    const record = await seedCase("tenant_artifact_tamper");
    const blobs = new MemoryPrivateBlobClient();
    const store = new ContentAddressedArtifactStore(postgres, blobs, {
      now: () => new Date(AT),
    });
    const bytes = new TextEncoder().encode("original bytes");
    const expected = descriptor(record, bytes);
    await store.put({ bytes, descriptor: expected });
    blobs.tamper(expected.objectKey, new TextEncoder().encode("tampered"));

    await expect(
      store.read(scope(record.tenantId, record.callerId), expected.artifactId),
    ).rejects.toBeInstanceOf(ArtifactIntegrityError);
  });

  it("deletes with the verified ETag and makes every later read unavailable", async () => {
    const record = await seedCase("tenant_artifact_delete");
    const blobs = new MemoryPrivateBlobClient();
    const store = new ContentAddressedArtifactStore(postgres, blobs, {
      now: () => new Date(AT),
    });
    const bytes = new TextEncoder().encode("delete me");
    const expected = descriptor(record, bytes);
    await store.put({ bytes, descriptor: expected });

    await expect(
      store.delete(scope(record.tenantId, record.callerId), expected.artifactId),
    ).resolves.toBe(true);
    await expect(
      store.read(scope(record.tenantId, record.callerId), expected.artifactId),
    ).resolves.toBeNull();
    await expect(
      store.delete(scope(record.tenantId, record.callerId), expected.artifactId),
    ).resolves.toBe(false);
    expect(blobs.deletes).toEqual([
      { etag: digest(bytes), pathname: expected.objectKey },
    ]);
  });
});
