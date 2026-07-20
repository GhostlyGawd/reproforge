import { createHash } from "node:crypto";

import { z } from "zod";

import {
  runSerializableTransaction,
  type PostgresDatabase,
} from "@/infrastructure/postgres/database";

const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const inputSchema = z
  .object({
    at: z.string().datetime(),
    idempotencyKey: z.string().min(1).max(128),
    principalId: identifier,
    tenantId: identifier,
  })
  .strict();

export class PostgresAccountExportQuotaError extends Error {
  readonly code = "ACCOUNT_EXPORT_QUOTA_UNAVAILABLE" as const;

  constructor() {
    super("The account export quota is unavailable");
    this.name = "PostgresAccountExportQuotaError";
  }
}

function quotaId(input: {
  idempotencyKey: string;
  principalId: string;
  tenantId: string;
}): string {
  return `quota_account_export_${createHash("sha256")
    .update(
      [input.tenantId, input.principalId, input.idempotencyKey].join("\u0000"),
    )
    .digest("hex")
    .slice(0, 48)}`;
}

function utcWindow(at: string): {
  end: string;
  retentionUntil: string;
  start: string;
} {
  const parsed = new Date(at);
  const start = new Date(
    Date.UTC(
      parsed.getUTCFullYear(),
      parsed.getUTCMonth(),
      parsed.getUTCDate(),
    ),
  );
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1_000);
  const retentionUntil = new Date(at);
  retentionUntil.setUTCFullYear(retentionUntil.getUTCFullYear() + 1);
  return {
    end: end.toISOString(),
    retentionUntil: retentionUntil.toISOString(),
    start: start.toISOString(),
  };
}

export class PostgresAccountExportQuota {
  private readonly limit: number;

  constructor(
    private readonly database: PostgresDatabase,
    options: { limit?: number } = {},
  ) {
    this.limit = options.limit ?? 20;
    if (!Number.isInteger(this.limit) || this.limit < 1 || this.limit > 1_000) {
      throw new PostgresAccountExportQuotaError();
    }
  }

  async consume(rawInput: {
    at: string;
    idempotencyKey: string;
    principalId: string;
    tenantId: string;
  }): Promise<{ allowed: boolean; reused: boolean }> {
    const parsed = inputSchema.safeParse(rawInput);
    if (!parsed.success) throw new PostgresAccountExportQuotaError();
    const input = parsed.data;
    const at = new Date(input.at);
    if (at.toISOString() !== input.at) {
      throw new PostgresAccountExportQuotaError();
    }
    const id = quotaId(input);
    const window = utcWindow(input.at);
    try {
      return await runSerializableTransaction(this.database, async (executor) => {
        await executor.query(
          "SELECT pg_advisory_xact_lock(hashtext($1)) AS quota_lock",
          [`quota:${input.tenantId}:exports`],
        );
        const account = await executor.query<{
          active: boolean;
          principal: boolean;
        }>(
          `SELECT t.status = 'ACTIVE' AS active,
                  EXISTS (
                    SELECT 1 FROM principals p
                     WHERE p.tenant_id = t.id AND p.id = $2
                  ) AS principal
             FROM tenants t
            WHERE t.id = $1
            FOR UPDATE`,
          [input.tenantId, input.principalId],
        );
        if (!account.rows[0]?.active || !account.rows[0]?.principal) {
          throw new PostgresAccountExportQuotaError();
        }
        const existing = await executor.query<{ id: string }>(
          `SELECT id FROM quota_ledger
            WHERE tenant_id = $1 AND id = $2 AND resource = 'exports'`,
          [input.tenantId, id],
        );
        if (existing.rows[0]) return { allowed: true, reused: true };
        const usage = await executor.query<{ amount: number | string }>(
          `SELECT coalesce(sum(actual_amount), 0) AS amount
             FROM quota_ledger
            WHERE tenant_id = $1 AND resource = 'exports'
              AND state = 'COMMITTED'
              AND window_start = $2 AND window_end = $3`,
          [input.tenantId, window.start, window.end],
        );
        const used = Number(usage.rows[0]?.amount ?? 0);
        if (!Number.isSafeInteger(used) || used < 0) {
          throw new PostgresAccountExportQuotaError();
        }
        if (used >= this.limit) return { allowed: false, reused: false };
        const inserted = await executor.query<{ id: string }>(
          `INSERT INTO quota_ledger (
             tenant_id, id, case_id, job_id, resource,
             window_start, window_end, reserved_amount, actual_amount,
             state, expires_at, created_at, updated_at, retention_until
           ) VALUES (
             $1, $2, NULL, NULL, 'exports',
             $3, $4, 1, 1, 'COMMITTED', $4, $5, $5, $6
           )
           ON CONFLICT (tenant_id, id) DO NOTHING
           RETURNING id`,
          [
            input.tenantId,
            id,
            window.start,
            window.end,
            input.at,
            window.retentionUntil,
          ],
        );
        if (!inserted.rows[0]) return { allowed: true, reused: true };
        return { allowed: true, reused: false };
      });
    } catch (error) {
      if (error instanceof PostgresAccountExportQuotaError) throw error;
      throw new PostgresAccountExportQuotaError();
    }
  }
}
