import { createHash } from "node:crypto";

import { z } from "zod";

import type { AuditSink } from "@/application/ports/production";
import type {
  QuarantineRecord,
  SandboxQuarantineSink,
} from "@/execution/sandbox-lifecycle";

const contextualRecordSchema = z
  .object({
    actorId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
    attemptId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
    providerResourceId: z.string().min(1).max(512),
    reason: z.literal("cleanup-failed"),
    resourceType: z.enum(["sandbox", "snapshot"]),
    tenantId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  })
  .strict();

function eventId(input: z.infer<typeof contextualRecordSchema>): string {
  return `audit_quarantine_${createHash("sha256")
    .update(
      [
        input.tenantId,
        input.attemptId,
        input.resourceType,
        input.providerResourceId,
      ].join("\u0000"),
    )
    .digest("hex")
    .slice(0, 48)}`;
}

export class AuditSandboxQuarantineSink implements SandboxQuarantineSink {
  constructor(
    private readonly audit: AuditSink,
    private readonly clock: { now(): Date } = { now: () => new Date() },
  ) {}

  async record(rawRecord: QuarantineRecord): Promise<void> {
    const record = contextualRecordSchema.parse(rawRecord);
    await this.audit.append({
      action: "sandbox.cleanup-quarantined",
      actorId: record.actorId,
      eventId: eventId(record),
      metadata: {
        cleanupKind: record.resourceType,
        providerId: record.providerResourceId,
        reason: record.reason,
      },
      occurredAt: this.clock.now().toISOString(),
      outcome: "failure",
      targetId: record.attemptId,
      targetType: "job",
      tenantId: record.tenantId,
    });
  }
}
