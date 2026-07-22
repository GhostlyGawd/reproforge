import { createHash } from "node:crypto";

import { Sandbox, Snapshot } from "@vercel/sandbox";
import { z } from "zod";

import type { AuditSink } from "@/application/ports/production";
import type { PostgresDatabase } from "@/infrastructure/postgres/database";

const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const providerResourceId = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value));
const resourceType = z.enum(["sandbox", "snapshot"]);

const resolveSchema = z
  .object({
    actorId: identifier,
    attemptId: identifier,
    providerResourceId,
    resourceType,
    tenantId: identifier,
  })
  .strict();

const listSchema = z.object({ limit: z.number().int().min(1).max(100) }).strict();

export type QuarantineResource = z.infer<typeof resolveSchema>;
export type QuarantineDelete = Pick<
  QuarantineResource,
  "providerResourceId" | "resourceType"
>;

export class QuarantineRecordNotFoundError extends Error {
  readonly code = "QUARANTINE_RECORD_NOT_FOUND" as const;

  constructor() {
    super("The quarantined resource was not found");
    this.name = "QuarantineRecordNotFoundError";
  }
}

type Dependencies = Readonly<{
  audit: AuditSink;
  clock?: { now(): Date };
  database: PostgresDatabase;
  deleteResource?: (input: QuarantineDelete) => Promise<void>;
}>;

type QuarantineRow = {
  attempt_id: string;
  provider_resource_id: string;
  quarantined_at: Date | string;
  resource_type: string;
  tenant_id: string;
};

function timestamp(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function resolvedEventId(input: QuarantineResource): string {
  return `audit_quarantine_resolved_${createHash("sha256")
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

export async function deleteVercelQuarantineResource(
  input: QuarantineDelete,
): Promise<void> {
  if (input.resourceType === "sandbox") {
    const sandbox = await Sandbox.get({
      name: input.providerResourceId,
      resume: false,
    });
    await sandbox.delete();
    return;
  }
  const snapshot = await Snapshot.get({
    snapshotId: input.providerResourceId,
  });
  await snapshot.delete();
}

export class PostgresSandboxQuarantineOperator {
  private readonly clock: { now(): Date };
  private readonly deleteResource: (input: QuarantineDelete) => Promise<void>;

  constructor(private readonly dependencies: Dependencies) {
    this.clock = dependencies.clock ?? { now: () => new Date() };
    this.deleteResource =
      dependencies.deleteResource ?? deleteVercelQuarantineResource;
  }

  async listOpen(rawInput: { limit: number }) {
    const input = listSchema.parse(rawInput);
    const result = await this.dependencies.database.query<QuarantineRow>(
      `SELECT q.tenant_id,
              q.target_id AS attempt_id,
              q.metadata->>'providerId' AS provider_resource_id,
              q.metadata->>'cleanupKind' AS resource_type,
              q.occurred_at AS quarantined_at
         FROM audit_events q
        WHERE q.action = 'sandbox.cleanup-quarantined'
          AND NOT EXISTS (
            SELECT 1
              FROM audit_events r
             WHERE r.tenant_id = q.tenant_id
               AND r.action = 'sandbox.cleanup-resolved'
               AND r.target_id = q.target_id
               AND r.metadata->>'providerId' = q.metadata->>'providerId'
               AND r.metadata->>'cleanupKind' = q.metadata->>'cleanupKind'
          )
        ORDER BY q.occurred_at, q.tenant_id, q.target_id
        LIMIT $1`,
      [input.limit],
    );
    return result.rows.map((row) => ({
      attemptId: identifier.parse(row.attempt_id),
      providerResourceId: providerResourceId.parse(row.provider_resource_id),
      quarantinedAt: timestamp(row.quarantined_at),
      resourceType: resourceType.parse(row.resource_type),
      tenantId: identifier.parse(row.tenant_id),
    }));
  }

  async resolve(rawInput: QuarantineResource): Promise<{ changed: boolean }> {
    const input = resolveSchema.parse(rawInput);
    const state = await this.lookup(input);
    if (state.resolved) return { changed: false };
    if (!state.quarantined) throw new QuarantineRecordNotFoundError();

    await this.deleteResource({
      providerResourceId: input.providerResourceId,
      resourceType: input.resourceType,
    });
    try {
      await this.dependencies.audit.append({
        action: "sandbox.cleanup-resolved",
        actorId: input.actorId,
        eventId: resolvedEventId(input),
        metadata: {
          cleanupKind: input.resourceType,
          providerId: input.providerResourceId,
        },
        occurredAt: this.clock.now().toISOString(),
        outcome: "success",
        targetId: input.attemptId,
        targetType: "job",
        tenantId: input.tenantId,
      });
    } catch (error) {
      if ((await this.lookup(input)).resolved) return { changed: false };
      throw error;
    }
    return { changed: true };
  }

  private async lookup(input: QuarantineResource) {
    const result = await this.dependencies.database.query<{
      quarantined: boolean;
      resolved: boolean;
    }>(
      `SELECT
         EXISTS (
           SELECT 1 FROM audit_events
            WHERE tenant_id = $1
              AND action = 'sandbox.cleanup-quarantined'
              AND target_id = $2
              AND metadata->>'providerId' = $3
              AND metadata->>'cleanupKind' = $4
         ) AS quarantined,
         EXISTS (
           SELECT 1 FROM audit_events
            WHERE tenant_id = $1
              AND action = 'sandbox.cleanup-resolved'
              AND target_id = $2
              AND metadata->>'providerId' = $3
              AND metadata->>'cleanupKind' = $4
         ) AS resolved`,
      [
        input.tenantId,
        input.attemptId,
        input.providerResourceId,
        input.resourceType,
      ],
    );
    return result.rows[0] ?? { quarantined: false, resolved: false };
  }
}
