import { createHash } from "node:crypto";

import {
  tenantScopeSchema,
  type TenantScope,
  type UnitOfWork,
} from "@/application/ports/production";

export type DurableCancellationResult = Readonly<{
  accepted: boolean;
  changed: boolean;
  disposition: "cancelled" | "not-found" | "requested";
}>;

function cancellationId(
  prefix: "audit_cancel" | "outbox_cancel",
  tenantId: string,
  jobId: string,
): string {
  const digest = createHash("sha256")
    .update(`${tenantId}:${jobId}:cancellation`)
    .digest("hex")
    .slice(0, 40);
  return `${prefix}_${digest}`;
}

function canonicalTimestamp(value: string): string | null {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value
    ? null
    : parsed.toISOString();
}

export async function requestDurableCancellation(
  unitOfWork: UnitOfWork,
  input: { at: string; jobId: string; scope: TenantScope },
): Promise<DurableCancellationResult> {
  const scope = tenantScopeSchema.parse(input.scope);
  const at = canonicalTimestamp(input.at);
  if (!at || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.jobId)) {
    throw new Error("Invalid durable cancellation request");
  }

  return unitOfWork.run(async (ports) => {
    const result = await ports.reproductions.requestCancellation(
      scope,
      input.jobId,
      at,
    );
    if (!result) {
      return {
        accepted: false,
        changed: false,
        disposition: "not-found",
      };
    }
    if (result.changed) {
      await ports.audit.append({
        action: "job.cancellation-requested",
        actorId: scope.principalId,
        eventId: cancellationId(
          "audit_cancel",
          scope.tenantId,
          input.jobId,
        ),
        metadata: { disposition: result.disposition },
        occurredAt: at,
        outcome: "success",
        targetId: input.jobId,
        targetType: "job",
        tenantId: scope.tenantId,
      });
      await ports.outbox.append({
        caseId: result.caseId,
        eventId: cancellationId(
          "outbox_cancel",
          scope.tenantId,
          input.jobId,
        ),
        jobId: input.jobId,
        kind: "reproduction.cancelled",
        schemaVersion: "1.0",
        tenantId: scope.tenantId,
      });
    }
    return {
      accepted: true,
      changed: result.changed,
      disposition: result.disposition,
    };
  });
}
