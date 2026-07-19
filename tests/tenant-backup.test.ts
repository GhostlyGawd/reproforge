import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TenantBackupError } from "@/application/tenant-backup";
import { ContentAddressedArtifactStore } from "@/infrastructure/artifacts/content-addressed-store";
import { JsonTenantBackupLogger } from "@/infrastructure/backup/observability";
import { PostgresTenantBackupService } from "@/infrastructure/backup/postgres-tenant-backup";
import { applyPostgresMigrations } from "@/infrastructure/postgres/migrations";
import { PostgresDurableReproductionRepository } from "@/infrastructure/postgres/repositories";

import { durableScope } from "./helpers/durable-fixture";
import { MemoryPrivateBlobClient } from "./helpers/memory-private-blob-client";
import { pgliteMigrationClient } from "./helpers/pglite-migration-client";
import { pglitePostgresDatabase } from "./helpers/pglite-postgres-database";
import {
  BACKUP_BODY_MARKER,
  seedVerifiedBackupTenant,
} from "./helpers/tenant-backup-fixture";

vi.setConfig({ testTimeout: 45_000 });

const databases: PGlite[] = [];

async function database(): Promise<PGlite> {
  const value = new PGlite();
  databases.push(value);
  await applyPostgresMigrations(pgliteMigrationClient(value));
  return value;
}

function logger(lines: string[]) {
  return new JsonTenantBackupLogger({
    sink: {
      error: (line) => lines.push(line),
      info: (line) => lines.push(line),
    },
  });
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((value) => value.close()));
});

describe("tenant backup and restore", () => {
  it("restores a complete verified reproduction and independently readable bundle", async () => {
    const source = await database();
    const destination = await database();
    const sourceBlobs = new MemoryPrivateBlobClient();
    const destinationBlobs = new MemoryPrivateBlobClient();
    const fixture = await seedVerifiedBackupTenant(source, sourceBlobs);
    await source.query(
      "INSERT INTO tenants (id) VALUES ('tenant_out_of_scope')",
    );
    const lines: string[] = [];
    const sourceService = new PostgresTenantBackupService(
      pglitePostgresDatabase(source),
      sourceBlobs,
      { now: () => new Date("2026-07-19T21:00:00.000Z") },
      logger(lines),
    );
    const destinationService = new PostgresTenantBackupService(
      pglitePostgresDatabase(destination),
      destinationBlobs,
      { now: () => new Date("2026-07-19T22:00:00.000Z") },
      logger(lines),
    );

    const archive = await sourceService.exportTenant(fixture.tenantId);
    expect(archive.manifest.reproductions).toHaveLength(1);
    expect(archive.manifest.evidence).toHaveLength(1);
    expect(archive.manifest.artifacts).toEqual([fixture.artifact]);
    expect(Object.keys(archive.objects)).toEqual([fixture.artifact.objectKey]);
    expect(JSON.stringify(archive.manifest)).not.toContain("tenant_out_of_scope");
    expect(sourceBlobs.gets).toEqual([fixture.artifact.objectKey]);

    await expect(
      destinationService.restoreTenant({
        archive,
        requestedBy: "operator_backup",
      }),
    ).resolves.toMatchObject({ restored: true });
    await expect(
      destinationService.restoreTenant({
        archive,
        requestedBy: "operator_backup",
      }),
    ).resolves.toMatchObject({ restored: false });

    const restoredRecord = await new PostgresDurableReproductionRepository(
      pglitePostgresDatabase(destination),
    ).findByCaseId(
      durableScope(fixture.tenantId, fixture.callerId),
      fixture.caseId,
    );
    expect(restoredRecord).toMatchObject({
      caseId: fixture.caseId,
      jobId: fixture.jobId,
      snapshot: {
        case: { state: "VERIFIED" },
        job: { state: "SUCCEEDED" },
      },
      tenantId: fixture.tenantId,
    });

    const restoredArtifact = await new ContentAddressedArtifactStore(
      pglitePostgresDatabase(destination),
      destinationBlobs,
      { now: () => new Date("2026-07-19T22:00:00.000Z") },
    ).read(durableScope(fixture.tenantId, fixture.callerId), fixture.artifact.artifactId);
    expect(restoredArtifact?.bytes).toEqual(fixture.body);
    const evidence = await destination.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM run_evidence WHERE tenant_id = $1",
      [fixture.tenantId],
    );
    expect(evidence.rows[0]?.count).toBe("1");
    expect(destinationBlobs.puts).toEqual([fixture.artifact.objectKey]);
    expect(lines.join("\n")).not.toContain(BACKUP_BODY_MARKER);
    expect(lines.map((line) => JSON.parse(line))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: "tenant-backup.exported" }),
        expect.objectContaining({ event: "tenant-backup.restored" }),
        expect.objectContaining({ event: "tenant-backup.verified" }),
      ]),
    );
  });

  it("rejects corrupted bytes before writing any destination state", async () => {
    const source = await database();
    const destination = await database();
    const sourceBlobs = new MemoryPrivateBlobClient();
    const destinationBlobs = new MemoryPrivateBlobClient();
    const fixture = await seedVerifiedBackupTenant(source, sourceBlobs);
    const sourceService = new PostgresTenantBackupService(
      pglitePostgresDatabase(source),
      sourceBlobs,
      { now: () => new Date("2026-07-19T21:00:00.000Z") },
      logger([]),
    );
    const destinationService = new PostgresTenantBackupService(
      pglitePostgresDatabase(destination),
      destinationBlobs,
      { now: () => new Date("2026-07-19T22:00:00.000Z") },
      logger([]),
    );
    const archive = await sourceService.exportTenant(fixture.tenantId);
    const corrupted = {
      ...archive,
      objects: {
        ...archive.objects,
        [fixture.artifact.objectKey]: new TextEncoder().encode("tampered"),
      },
    };

    await expect(
      destinationService.restoreTenant({
        archive: corrupted,
        requestedBy: "operator_backup",
      }),
    ).rejects.toMatchObject({
      code: "TENANT_BACKUP_CORRUPT",
    } satisfies Partial<TenantBackupError>);
    const tenants = await destination.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM tenants",
    );
    expect(tenants.rows[0]?.count).toBe("0");
    expect(destinationBlobs.puts).toEqual([]);

    await expect(
      destinationService.restoreTenant({
        archive: {
          ...archive,
          manifest: {
            ...archive.manifest,
            createdAt: "2026-07-19T21:00:01.000Z",
          },
        },
        requestedBy: "operator_backup",
      }),
    ).rejects.toMatchObject({ code: "TENANT_BACKUP_CORRUPT" });
  });

  it("fails closed when a different restore already owns the tenant identity", async () => {
    const source = await database();
    const destination = await database();
    const sourceBlobs = new MemoryPrivateBlobClient();
    const fixture = await seedVerifiedBackupTenant(source, sourceBlobs);
    await destination.query("INSERT INTO tenants (id) VALUES ($1)", [fixture.tenantId]);
    const archive = await new PostgresTenantBackupService(
      pglitePostgresDatabase(source),
      sourceBlobs,
      { now: () => new Date("2026-07-19T21:00:00.000Z") },
      logger([]),
    ).exportTenant(fixture.tenantId);

    await expect(
      new PostgresTenantBackupService(
        pglitePostgresDatabase(destination),
        new MemoryPrivateBlobClient(),
        { now: () => new Date("2026-07-19T22:00:00.000Z") },
        logger([]),
      ).restoreTenant({ archive, requestedBy: "operator_backup" }),
    ).rejects.toMatchObject({
      code: "TENANT_RESTORE_TARGET_EXISTS",
    } satisfies Partial<TenantBackupError>);
  });
});
