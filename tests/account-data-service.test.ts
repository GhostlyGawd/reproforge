import { describe, expect, it, vi } from "vitest";

import {
  ACCOUNT_DELETION_CONFIRMATION,
  AccountDataError,
  AccountDataService,
} from "@/application/account-data-service";
import {
  parsePortableTenantBackup,
  sealTenantBackupArchive,
  tenantBackupManifestSchema,
} from "@/application/tenant-backup";

const AT = "2026-07-20T18:00:00.000Z";
const RETENTION = "2026-08-20T18:00:00.000Z";
const principal = {
  callerId: "principal_account_data",
  principalId: "principal_account_data",
  tenantId: "tenant_account_data",
};

function emptyArchive() {
  return sealTenantBackupArchive(
    tenantBackupManifestSchema.parse({
      artifacts: [],
      createdAt: AT,
      evidence: [],
      reproductions: [],
      schemaVersion: "1.0",
      tenant: {
        createdAt: AT,
        retentionUntil: RETENTION,
        status: "ACTIVE",
        tenantId: principal.tenantId,
        updatedAt: AT,
      },
    }),
    {},
  );
}

function dependencies() {
  return {
    audit: { append: vi.fn(async () => undefined) },
    backup: { exportTenant: vi.fn(async () => emptyArchive()) },
    clock: { now: () => new Date(AT) },
    exportQuota: {
      consume: vi.fn(async () => ({ allowed: true, reused: false })),
    },
    nextAuditEventId: () => "audit_account_export",
    retention: {
      request: vi.fn(async () => ({ created: true, requestId: "unused" })),
    },
  };
}

describe("account data service", () => {
  it("exports one integrity-checked portable tenant archive and audits only metadata", async () => {
    const ports = dependencies();
    const service = new AccountDataService(ports);

    const exported = await service.exportAccountData(principal, {
      idempotencyKey: "account-export-1",
    });

    expect(parsePortableTenantBackup(exported.bytes)).toEqual(emptyArchive());
    expect(exported).toMatchObject({
      contentType: "application/vnd.reproforge.account-export+json",
      filename: "reproforge-account-export-2026-07-20.json",
      manifestSha256: emptyArchive().manifestSha256,
    });
    expect(ports.exportQuota.consume).toHaveBeenCalledWith({
      at: AT,
      idempotencyKey: "account-export-1",
      principalId: principal.principalId,
      tenantId: principal.tenantId,
    });
    expect(ports.backup.exportTenant).toHaveBeenCalledWith(principal.tenantId);
    expect(ports.audit.append).toHaveBeenCalledWith({
      action: "account.data-exported",
      actorId: principal.principalId,
      eventId: "audit_account_export",
      metadata: {
        artifactCount: 0,
        byteCount: exported.bytes.byteLength,
        caseCount: 0,
        evidenceCount: 0,
        manifestSha256: emptyArchive().manifestSha256,
      },
      occurredAt: AT,
      outcome: "success",
      targetId: principal.tenantId,
      targetType: "account",
      tenantId: principal.tenantId,
    });
  });

  it("fails before backup when the export quota is exhausted", async () => {
    const ports = dependencies();
    ports.exportQuota.consume.mockResolvedValue({ allowed: false, reused: false });

    await expect(
      new AccountDataService(ports).exportAccountData(principal, {
        idempotencyKey: "account-export-denied",
      }),
    ).rejects.toMatchObject({
      code: "EXPORT_QUOTA_EXCEEDED",
      retryable: false,
    } satisfies Partial<AccountDataError>);
    expect(ports.backup.exportTenant).not.toHaveBeenCalled();
    expect(ports.audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "account.data-export-denied",
        metadata: { code: "EXPORT_QUOTA_EXCEEDED" },
        outcome: "denied",
      }),
    );
  });

  it("turns explicit deletion confirmation into an idempotent immediate request", async () => {
    const ports = dependencies();
    ports.retention.request
      .mockResolvedValueOnce({ created: true, requestId: "ignored" })
      .mockResolvedValueOnce({ created: false, requestId: "ignored" });
    const service = new AccountDataService(ports);
    const input = {
      confirmation: ACCOUNT_DELETION_CONFIRMATION,
      idempotencyKey: "account-delete-1",
    };

    const first = await service.requestAccountDeletion(principal, input);
    const second = await service.requestAccountDeletion(principal, input);

    expect(first).toMatchObject({ created: true, status: "scheduled" });
    expect(second).toMatchObject({
      created: false,
      requestId: first.requestId,
      status: "scheduled",
    });
    expect(first.requestId).toMatch(/^delete_[a-f0-9]{48}$/);
    expect(ports.retention.request).toHaveBeenNthCalledWith(1, {
      at: AT,
      requestId: first.requestId,
      scheduledAt: AT,
      scope: principal,
    });
  });

  it("rejects missing confirmation before touching retention state", async () => {
    const ports = dependencies();

    await expect(
      new AccountDataService(ports).requestAccountDeletion(principal, {
        confirmation: "delete it",
        idempotencyKey: "account-delete-invalid",
      }),
    ).rejects.toMatchObject({
      code: "INVALID_ACCOUNT_DATA_REQUEST",
      retryable: false,
    } satisfies Partial<AccountDataError>);
    expect(ports.retention.request).not.toHaveBeenCalled();
  });
});
