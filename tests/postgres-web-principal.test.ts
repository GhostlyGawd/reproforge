import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { WebIdentity } from "@/auth/web-session";
import { PostgresWebPrincipalSession } from "@/infrastructure/identity/postgres-web-principal-session";
import { applyPostgresMigrations } from "@/infrastructure/postgres/migrations";

import { pgliteMigrationClient } from "./helpers/pglite-migration-client";
import { pglitePostgresDatabase } from "./helpers/pglite-postgres-database";

const identity: WebIdentity = {
  email: "synthetic@example.test",
  issuer: "https://issuer.example/",
  name: "Synthetic User",
  picture: null,
  subject: "auth0|synthetic-user",
  tenantId: "tenant-alpha",
};

describe("Postgres web principal session", () => {
  let database: PGlite;

  beforeEach(async () => {
    database = new PGlite();
    await database.waitReady;
    await applyPostgresMigrations(pgliteMigrationClient(database));
  });

  afterEach(async () => {
    await database.close();
  });

  it("provisions one stable principal from verified server-side claims and audits login", async () => {
    let principalSequence = 0;
    let auditSequence = 0;
    const sessions = new PostgresWebPrincipalSession(
      pglitePostgresDatabase(database),
      {
        auditEventId: () => `audit_login_${++auditSequence}`,
        clock: { now: () => new Date("2026-07-20T00:00:00.000Z") },
        principalId: () => `principal_${++principalSequence}`,
      },
    );

    await expect(sessions.resolve(identity)).resolves.toEqual({
      principalId: "principal_1",
      tenantId: "tenant-alpha",
    });
    await expect(sessions.resolve(identity)).resolves.toEqual({
      principalId: "principal_1",
      tenantId: "tenant-alpha",
    });
    const principals = await database.query<Record<string, unknown>>(
      "SELECT * FROM principals WHERE tenant_id = $1",
      [identity.tenantId],
    );
    expect(principals.rows).toHaveLength(1);
    expect(JSON.stringify(principals.rows)).not.toMatch(
      /synthetic@example|access_token|cookie|secret/i,
    );
    const audits = await database.query<{
      action: string;
      actor_id: string;
      metadata: unknown;
    }>(
      `SELECT action, actor_id, metadata
         FROM audit_events
        WHERE tenant_id = $1
        ORDER BY id`,
      [identity.tenantId],
    );
    expect(audits.rows).toEqual([
      {
        action: "account.login",
        actor_id: "principal_1",
        metadata: { provider: "auth0" },
      },
      {
        action: "account.login",
        actor_id: "principal_1",
        metadata: { provider: "auth0" },
      },
    ]);
  });

  it("rejects tenant reassignment and inactive tenant sessions", async () => {
    const sessions = new PostgresWebPrincipalSession(
      pglitePostgresDatabase(database),
      { principalId: () => "principal-alpha" },
    );
    await sessions.resolve(identity);
    await expect(
      sessions.resolve({ ...identity, tenantId: "tenant-beta" }),
    ).rejects.toMatchObject({ code: "WEB_PRINCIPAL_UNAVAILABLE" });

    await database.query(
      "UPDATE tenants SET status = 'SUSPENDED' WHERE id = $1",
      [identity.tenantId],
    );
    await expect(sessions.resolve(identity)).rejects.toMatchObject({
      code: "WEB_PRINCIPAL_UNAVAILABLE",
    });
  });
});
