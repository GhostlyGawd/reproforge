import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AuditSandboxQuarantineSink } from "@/infrastructure/execution/audit-sandbox-quarantine-sink";
import {
  PostgresSandboxQuarantineOperator,
  QuarantineRecordNotFoundError,
} from "@/infrastructure/operations/postgres-sandbox-quarantine-operator";
import { applyPostgresMigrations } from "@/infrastructure/postgres/migrations";
import { PostgresAuditSink } from "@/infrastructure/postgres/repositories";

import { pgliteMigrationClient } from "./helpers/pglite-migration-client";
import { pglitePostgresDatabase } from "./helpers/pglite-postgres-database";

describe("sandbox quarantine operator", () => {
  let database: PGlite;

  beforeEach(async () => {
    database = new PGlite();
    await applyPostgresMigrations(pgliteMigrationClient(database));
    await database.query("INSERT INTO tenants (id) VALUES ('tenant_quarantine_ops')");
  });

  afterEach(async () => {
    await database.close();
  });

  it("lists, deletes, audits, and idempotently resolves an exact quarantined resource", async () => {
    const postgres = pglitePostgresDatabase(database);
    const audit = new PostgresAuditSink(postgres);
    const sink = new AuditSandboxQuarantineSink(audit, {
      now: () => new Date("2026-07-20T21:00:00.000Z"),
    });
    await sink.record({
      actorId: "principal_quarantine_ops",
      attemptId: "job_quarantine_ops.attempt-2",
      providerResourceId: "sandbox_quarantine_exact",
      reason: "cleanup-failed",
      resourceType: "sandbox",
      tenantId: "tenant_quarantine_ops",
    });
    const deleteResource = vi.fn(async () => undefined);
    const operator = new PostgresSandboxQuarantineOperator({
      audit,
      clock: { now: () => new Date("2026-07-20T21:05:00.000Z") },
      database: postgres,
      deleteResource,
    });

    await expect(operator.listOpen({ limit: 10 })).resolves.toEqual([
      {
        attemptId: "job_quarantine_ops.attempt-2",
        providerResourceId: "sandbox_quarantine_exact",
        quarantinedAt: "2026-07-20T21:00:00.000Z",
        resourceType: "sandbox",
        tenantId: "tenant_quarantine_ops",
      },
    ]);
    const command = {
      actorId: "operator_private_beta",
      attemptId: "job_quarantine_ops.attempt-2",
      providerResourceId: "sandbox_quarantine_exact",
      resourceType: "sandbox" as const,
      tenantId: "tenant_quarantine_ops",
    };
    await expect(operator.resolve(command)).resolves.toEqual({ changed: true });
    await expect(operator.resolve(command)).resolves.toEqual({ changed: false });
    expect(deleteResource).toHaveBeenCalledTimes(1);
    expect(deleteResource).toHaveBeenCalledWith({
      providerResourceId: "sandbox_quarantine_exact",
      resourceType: "sandbox",
    });
    await expect(operator.listOpen({ limit: 10 })).resolves.toEqual([]);

    const rows = await database.query<{ action: string; outcome: string }>(
      "SELECT action, outcome FROM audit_events WHERE tenant_id = $1 ORDER BY occurred_at",
      ["tenant_quarantine_ops"],
    );
    expect(rows.rows).toEqual([
      { action: "sandbox.cleanup-quarantined", outcome: "failure" },
      { action: "sandbox.cleanup-resolved", outcome: "success" },
    ]);
  });

  it("refuses an unrecorded resource before provider deletion", async () => {
    const postgres = pglitePostgresDatabase(database);
    const deleteResource = vi.fn(async () => undefined);
    const operator = new PostgresSandboxQuarantineOperator({
      audit: new PostgresAuditSink(postgres),
      database: postgres,
      deleteResource,
    });

    await expect(
      operator.resolve({
        actorId: "operator_private_beta",
        attemptId: "job_unknown.attempt-1",
        providerResourceId: "sandbox_unknown",
        resourceType: "sandbox",
        tenantId: "tenant_quarantine_ops",
      }),
    ).rejects.toBeInstanceOf(QuarantineRecordNotFoundError);
    expect(deleteResource).not.toHaveBeenCalled();
  });
});
