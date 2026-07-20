import { randomUUID } from "node:crypto";

import { z } from "zod";

import type { WebIdentity } from "@/auth/web-session";
import { auditEventSchema } from "@/application/ports/production";
import type { GitHubInstallationActor } from "@/github/installation-state";
import {
  runSerializableTransaction,
  type PostgresDatabase,
  type PostgresExecutor,
} from "@/infrastructure/postgres/database";

const opaqueId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:|-]*$/);
const identitySchema = z
  .object({
    email: z.string().nullable(),
    issuer: z.url().refine((value) => new URL(value).protocol === "https:"),
    name: z.string().nullable(),
    picture: z.string().nullable(),
    subject: opaqueId,
    tenantId: opaqueId,
  })
  .strict();

export class WebPrincipalSessionError extends Error {
  readonly code = "WEB_PRINCIPAL_UNAVAILABLE" as const;

  constructor() {
    super("The authenticated principal is unavailable");
    this.name = "WebPrincipalSessionError";
  }
}

type Options = {
  auditEventId?: () => string;
  clock?: { now(): Date };
  principalId?: () => string;
};

type PrincipalRow = {
  principal_id: string;
  status: string;
  tenant_id: string;
};

export class PostgresWebPrincipalSession {
  private readonly auditEventId: () => string;
  private readonly clock: { now(): Date };
  private readonly principalId: () => string;

  constructor(
    private readonly database: PostgresDatabase,
    options: Options = {},
  ) {
    this.auditEventId =
      options.auditEventId ??
      (() => `audit_login_${randomUUID().replaceAll("-", "")}`);
    this.clock = options.clock ?? { now: () => new Date() };
    this.principalId =
      options.principalId ??
      (() => `principal_${randomUUID().replaceAll("-", "")}`);
  }

  async resolve(rawIdentity: WebIdentity): Promise<GitHubInstallationActor> {
    const parsed = identitySchema.safeParse(rawIdentity);
    if (!parsed.success) throw new WebPrincipalSessionError();
    const identity = parsed.data;
    try {
      return await runSerializableTransaction(this.database, async (executor) => {
        const at = this.clock.now().toISOString();
        await executor.query(
          `INSERT INTO tenants (id, created_at, updated_at)
           VALUES ($1, $2, $2)
           ON CONFLICT (id) DO NOTHING`,
          [identity.tenantId, at],
        );
        let principal = await this.lookup(executor, identity);
        if (!principal) {
          const tenant = await executor.query<{ status: string }>(
            "SELECT status FROM tenants WHERE id = $1 FOR UPDATE",
            [identity.tenantId],
          );
          if (tenant.rows[0]?.status !== "ACTIVE") {
            throw new WebPrincipalSessionError();
          }
          const principalId = opaqueId.parse(this.principalId());
          await executor.query(
            `INSERT INTO principals (
               tenant_id, id, provider, issuer, external_subject,
               created_at, updated_at, last_seen_at, retention_until
             ) VALUES (
               $1, $2, 'auth0', $3, $4, $5, $5, $5,
               $5::timestamptz + interval '365 days'
             )
             ON CONFLICT (issuer, external_subject) DO NOTHING`,
            [
              identity.tenantId,
              principalId,
              identity.issuer,
              identity.subject,
              at,
            ],
          );
          principal = await this.lookup(executor, identity);
        }
        if (
          !principal ||
          principal.status !== "ACTIVE" ||
          principal.tenant_id !== identity.tenantId
        ) {
          throw new WebPrincipalSessionError();
        }
        await executor.query(
          `UPDATE principals
              SET last_seen_at = $3, updated_at = $3
            WHERE tenant_id = $1 AND id = $2`,
          [principal.tenant_id, principal.principal_id, at],
        );
        const audit = auditEventSchema.parse({
          action: "account.login",
          actorId: principal.principal_id,
          eventId: this.auditEventId(),
          metadata: { provider: "auth0" },
          occurredAt: at,
          outcome: "success",
          targetId: principal.principal_id,
          targetType: "account",
          tenantId: principal.tenant_id,
        });
        await executor.query(
          `INSERT INTO audit_events (
             tenant_id, id, actor_id, action, target_type, target_id,
             outcome, metadata, occurred_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
          [
            audit.tenantId,
            audit.eventId,
            audit.actorId,
            audit.action,
            audit.targetType,
            audit.targetId,
            audit.outcome,
            JSON.stringify(audit.metadata),
            audit.occurredAt,
          ],
        );
        return {
          principalId: principal.principal_id,
          tenantId: principal.tenant_id,
        };
      });
    } catch (error) {
      if (error instanceof WebPrincipalSessionError) throw error;
      throw new WebPrincipalSessionError();
    }
  }

  private async lookup(
    executor: PostgresExecutor,
    identity: Pick<WebIdentity, "issuer" | "subject">,
  ): Promise<PrincipalRow | null> {
    const result = await executor.query<PrincipalRow>(
      `SELECT p.id AS principal_id, p.tenant_id, t.status
         FROM principals p
         JOIN tenants t ON t.id = p.tenant_id
        WHERE p.issuer = $1 AND p.external_subject = $2
        LIMIT 2`,
      [identity.issuer, identity.subject],
    );
    return result.rows.length === 1 ? result.rows[0] ?? null : null;
  }
}
