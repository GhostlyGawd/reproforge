import { z } from "zod";

import {
  durableOperationsSnapshotSchema,
  type DurableOperationsSnapshot,
} from "@/application/operations-dashboard";
import type { PostgresDatabase } from "@/infrastructure/postgres/database";

const inputSchema = z.object({ at: z.string().datetime({ offset: true }) }).strict();

type DashboardRow = {
  deletion_failed: unknown;
  deletion_pending: unknown;
  expired_leases: unknown;
  jobs_cancelled: unknown;
  jobs_failed: unknown;
  jobs_queued: unknown;
  jobs_running: unknown;
  jobs_succeeded: unknown;
  oldest_outbox_at: Date | string | null;
  oldest_queued_at: Date | string | null;
  outbox_dead: unknown;
  outbox_pending: unknown;
  quarantined_resources: unknown;
};

function integer(value: unknown): number {
  const parsed = typeof value === "bigint" ? Number(value) : Number(String(value));
  return z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).parse(parsed);
}

function ageSeconds(at: string, value: Date | string | null): number | null {
  if (value === null) return null;
  const timestamp = value instanceof Date ? value : new Date(value);
  const difference = Math.floor((Date.parse(at) - timestamp.getTime()) / 1_000);
  return z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).parse(
    Math.max(0, difference),
  );
}

export class PostgresOperationsDashboardSource {
  constructor(private readonly database: PostgresDatabase) {}

  async read(rawInput: { at: string }): Promise<DurableOperationsSnapshot> {
    const input = inputSchema.parse(rawInput);
    const result = await this.database.query<DashboardRow>(
      `SELECT
         (SELECT count(*)::text FROM jobs WHERE state = 'QUEUED') AS jobs_queued,
         (SELECT count(*)::text FROM jobs WHERE state = 'RUNNING') AS jobs_running,
         (SELECT count(*)::text FROM jobs WHERE state = 'SUCCEEDED') AS jobs_succeeded,
         (SELECT count(*)::text FROM jobs WHERE state = 'FAILED') AS jobs_failed,
         (SELECT count(*)::text FROM jobs WHERE state = 'CANCELLED') AS jobs_cancelled,
         (SELECT min(created_at) FROM jobs WHERE state = 'QUEUED') AS oldest_queued_at,
         (SELECT count(*)::text
            FROM jobs
           WHERE state = 'RUNNING' AND lease_expires_at <= $1) AS expired_leases,
         (SELECT count(*)::text
            FROM outbox_events
           WHERE status IN ('PENDING', 'SENDING')) AS outbox_pending,
         (SELECT count(*)::text
            FROM outbox_events
           WHERE status = 'DEAD') AS outbox_dead,
         (SELECT min(created_at)
            FROM outbox_events
           WHERE status IN ('PENDING', 'SENDING')) AS oldest_outbox_at,
         (SELECT count(*)::text
            FROM deletion_requests
           WHERE state IN ('REQUESTED', 'SCHEDULED', 'RUNNING')) AS deletion_pending,
         (SELECT count(*)::text
            FROM deletion_requests
           WHERE state = 'FAILED') AS deletion_failed,
         (SELECT count(*)::text
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
             )) AS quarantined_resources`,
      [input.at],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Operations dashboard query returned no row");
    return durableOperationsSnapshotSchema.parse({
      deletions: {
        failed: integer(row.deletion_failed),
        pending: integer(row.deletion_pending),
      },
      jobs: {
        cancelled: integer(row.jobs_cancelled),
        expiredLeases: integer(row.expired_leases),
        failed: integer(row.jobs_failed),
        oldestQueuedAgeSeconds: ageSeconds(input.at, row.oldest_queued_at),
        queued: integer(row.jobs_queued),
        running: integer(row.jobs_running),
        succeeded: integer(row.jobs_succeeded),
      },
      outbox: {
        dead: integer(row.outbox_dead),
        oldestPendingAgeSeconds: ageSeconds(input.at, row.oldest_outbox_at),
        pending: integer(row.outbox_pending),
      },
      quarantinedResources: integer(row.quarantined_resources),
    });
  }
}
