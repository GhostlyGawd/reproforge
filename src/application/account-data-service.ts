import { createHash, randomUUID } from "node:crypto";

import { z } from "zod";

import { ACCOUNT_DELETION_CONFIRMATION } from "@/application/account-data-contracts";
import {
  tenantScopeSchema,
  type AuditSink,
  type TenantScope,
} from "@/application/ports/production";
import {
  serializePortableTenantBackup,
  type TenantBackupArchive,
} from "@/application/tenant-backup";

export { ACCOUNT_DELETION_CONFIRMATION } from "@/application/account-data-contracts";

const idempotencyKey = z.string().min(1).max(128);
const exportInputSchema = z.object({ idempotencyKey }).strict();
const deletionInputSchema = z
  .object({
    confirmation: z.literal(ACCOUNT_DELETION_CONFIRMATION),
    idempotencyKey,
  })
  .strict();

type AccountExportQuota = {
  consume(input: {
    at: string;
    idempotencyKey: string;
    principalId: string;
    tenantId: string;
  }): Promise<{ allowed: boolean; reused: boolean }>;
};

type AccountDataDependencies = Readonly<{
  audit: AuditSink;
  backup: { exportTenant(tenantId: string): Promise<TenantBackupArchive> };
  clock?: { now(): Date };
  exportQuota: AccountExportQuota;
  nextAuditEventId?: () => string;
  retention: {
    request(input: {
      at: string;
      requestId: string;
      scheduledAt: string;
      scope: TenantScope;
    }): Promise<{ created: boolean; requestId: string }>;
  };
}>;

export class AccountDataError extends Error {
  constructor(
    readonly code:
      | "ACCOUNT_DELETION_UNAVAILABLE"
      | "ACCOUNT_EXPORT_UNAVAILABLE"
      | "EXPORT_QUOTA_EXCEEDED"
      | "INVALID_ACCOUNT_DATA_REQUEST",
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "AccountDataError";
  }
}

function invalidRequest(): AccountDataError {
  return new AccountDataError(
    "INVALID_ACCOUNT_DATA_REQUEST",
    "The account data request is invalid",
    false,
  );
}

function parseScope(rawScope: TenantScope): TenantScope {
  const parsed = tenantScopeSchema.safeParse(rawScope);
  if (!parsed.success) throw invalidRequest();
  return parsed.data;
}

function deletionRequestId(
  scope: TenantScope,
  idempotencyKeyValue: string,
): string {
  return `delete_${createHash("sha256")
    .update(
      [scope.tenantId, scope.principalId, idempotencyKeyValue].join("\u0000"),
    )
    .digest("hex")
    .slice(0, 48)}`;
}

export class AccountDataService {
  private readonly clock: { now(): Date };
  private readonly nextAuditEventId: () => string;

  constructor(private readonly dependencies: AccountDataDependencies) {
    this.clock = dependencies.clock ?? { now: () => new Date() };
    this.nextAuditEventId =
      dependencies.nextAuditEventId ??
      (() => `audit_account_export_${randomUUID().replaceAll("-", "")}`);
  }

  async exportAccountData(
    rawScope: TenantScope,
    rawInput: { idempotencyKey: string },
  ) {
    const scope = parseScope(rawScope);
    const parsed = exportInputSchema.safeParse(rawInput);
    if (!parsed.success) throw invalidRequest();
    const at = this.clock.now().toISOString();
    let quota: { allowed: boolean; reused: boolean };
    try {
      quota = await this.dependencies.exportQuota.consume({
        at,
        idempotencyKey: parsed.data.idempotencyKey,
        principalId: scope.principalId,
        tenantId: scope.tenantId,
      });
    } catch {
      throw new AccountDataError(
        "ACCOUNT_EXPORT_UNAVAILABLE",
        "The account export is temporarily unavailable",
        true,
      );
    }
    if (!quota.allowed) {
      await this.dependencies.audit
        .append({
          action: "account.data-export-denied",
          actorId: scope.principalId,
          eventId: this.nextAuditEventId(),
          metadata: { code: "EXPORT_QUOTA_EXCEEDED" },
          occurredAt: at,
          outcome: "denied",
          targetId: scope.tenantId,
          targetType: "account",
          tenantId: scope.tenantId,
        })
        .catch(() => undefined);
      throw new AccountDataError(
        "EXPORT_QUOTA_EXCEEDED",
        "The account export limit has been reached",
        false,
      );
    }

    try {
      const archive = await this.dependencies.backup.exportTenant(
        scope.tenantId,
      );
      if (archive.manifest.tenant.tenantId !== scope.tenantId) {
        throw new Error("Tenant mismatch");
      }
      const bytes = serializePortableTenantBackup(archive);
      await this.dependencies.audit.append({
        action: "account.data-exported",
        actorId: scope.principalId,
        eventId: this.nextAuditEventId(),
        metadata: {
          artifactCount: archive.manifest.artifacts.length,
          byteCount: bytes.byteLength,
          caseCount: archive.manifest.reproductions.length,
          evidenceCount: archive.manifest.evidence.length,
          manifestSha256: archive.manifestSha256,
        },
        occurredAt: at,
        outcome: "success",
        targetId: scope.tenantId,
        targetType: "account",
        tenantId: scope.tenantId,
      });
      return {
        bytes,
        contentType: "application/vnd.reproforge.account-export+json" as const,
        filename: `reproforge-account-export-${at.slice(0, 10)}.json`,
        manifestSha256: archive.manifestSha256,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    } catch (error) {
      if (error instanceof AccountDataError) throw error;
      throw new AccountDataError(
        "ACCOUNT_EXPORT_UNAVAILABLE",
        "The account export is temporarily unavailable",
        true,
      );
    }
  }

  async requestAccountDeletion(
    rawScope: TenantScope,
    rawInput: { confirmation: string; idempotencyKey: string },
  ) {
    const scope = parseScope(rawScope);
    const parsed = deletionInputSchema.safeParse(rawInput);
    if (!parsed.success) throw invalidRequest();
    const at = this.clock.now().toISOString();
    const requestId = deletionRequestId(scope, parsed.data.idempotencyKey);
    try {
      const result = await this.dependencies.retention.request({
        at,
        requestId,
        scheduledAt: at,
        scope,
      });
      return {
        created: result.created,
        requestId,
        status: "scheduled" as const,
      };
    } catch {
      throw new AccountDataError(
        "ACCOUNT_DELETION_UNAVAILABLE",
        "The account deletion request is temporarily unavailable",
        true,
      );
    }
  }
}
