import { z } from "zod";

import type {
  PrincipalDirectory,
  PrincipalLookup,
  PrincipalRecord,
} from "@/application/ports/identity";
import type { PostgresExecutor } from "@/infrastructure/postgres/database";

const lookupSchema = z
  .object({
    issuer: z.url().max(512),
    subject: z.string().min(1).max(512),
  })
  .strict();

const principalSchema = z
  .object({
    principalId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
    status: z.enum(["ACTIVE", "DELETED", "DELETING", "SUSPENDED"]),
    tenantId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  })
  .strict();

export class PostgresPrincipalDirectory implements PrincipalDirectory {
  constructor(private readonly executor: PostgresExecutor) {}

  async resolve(rawLookup: PrincipalLookup): Promise<PrincipalRecord | null> {
    const lookup = lookupSchema.parse(rawLookup);
    const result = await this.executor.query<{
      principal_id: string;
      status: string;
      tenant_id: string;
    }>(
      `SELECT p.id AS principal_id, p.tenant_id, t.status
         FROM principals p
         JOIN tenants t ON t.id = p.tenant_id
        WHERE p.issuer = $1 AND p.external_subject = $2
        LIMIT 2`,
      [lookup.issuer, lookup.subject],
    );
    if (result.rows.length !== 1) return null;
    const row = result.rows[0];
    const parsed = principalSchema.safeParse({
      principalId: row?.principal_id,
      status: row?.status,
      tenantId: row?.tenant_id,
    });
    return parsed.success ? parsed.data : null;
  }
}
