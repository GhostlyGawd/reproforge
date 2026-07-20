import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MigrationIntegrityError,
  applyPostgresMigrations,
  definePostgresMigration,
  loadPostgresMigrations,
} from "@/infrastructure/postgres/migrations";

import { pgliteMigrationClient } from "./helpers/pglite-migration-client";

vi.setConfig({ testTimeout: 30_000 });

const EXPECTED_TABLES = [
  "artifacts",
  "audit_events",
  "cases",
  "deletion_requests",
  "github_installation_states",
  "github_installations",
  "github_repositories",
  "idempotency_keys",
  "jobs",
  "outbox_events",
  "principals",
  "quota_ledger",
  "reproforge_schema_migrations",
  "run_evidence",
  "tenant_restore_sessions",
  "tenants",
];

const EXPECTED_INDEXES = [
  "artifacts_retention_idx",
  "audit_tenant_occurred_idx",
  "cases_tenant_state_idx",
  "deletion_schedule_idx",
  "github_installation_states_expiry_idx",
  "github_installations_tenant_status_idx",
  "github_repositories_tenant_active_idx",
  "jobs_expired_lease_idx",
  "jobs_tenant_state_next_attempt_idx",
  "outbox_pending_idx",
  "principals_external_subject_idx",
  "quota_tenant_window_idx",
  "run_evidence_job_idx",
  "tenant_restore_sessions_state_idx",
];

const databases: PGlite[] = [];

function createDatabase(): PGlite {
  const database = new PGlite();
  databases.push(database);
  return database;
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

describe("Postgres durable-foundation migrations", () => {
  it("uses one migration identity for LF and CRLF source files", () => {
    const lf = definePostgresMigration(
      "0001_line_endings",
      "CREATE TABLE portable (\n  id text PRIMARY KEY\n);\n",
    );
    const crlf = definePostgresMigration(
      "0001_line_endings",
      "CREATE TABLE portable (\r\n  id text PRIMARY KEY\r\n);\r\n",
    );

    expect(crlf).toEqual(lf);
    expect(crlf.sql).not.toContain("\r");
  });

  it("applies from empty, records checksums, and safely skips a rerun", async () => {
    const database = createDatabase();
    const client = pgliteMigrationClient(database);
    const migrations = loadPostgresMigrations();

    const first = await applyPostgresMigrations(client, migrations);
    const second = await applyPostgresMigrations(client, migrations);
    const tables = await database.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
    );
    const ledger = await database.query<{ checksum: string; id: string }>(
      "SELECT id, checksum FROM reproforge_schema_migrations ORDER BY id",
    );

    expect(first).toEqual({
      applied: migrations.map((migration) => migration.id),
      skipped: [],
    });
    expect(second).toEqual({
      applied: [],
      skipped: migrations.map((migration) => migration.id),
    });
    expect(tables.rows.map(({ tablename }) => tablename)).toEqual(EXPECTED_TABLES);
    expect(ledger.rows).toEqual(
      migrations.map(({ checksum, id }) => ({ checksum, id })),
    );
    expect(ledger.rows.every(({ checksum }) => /^[a-f0-9]{64}$/.test(checksum))).toBe(
      true,
    );
  });

  it("creates the tenant, lifecycle, retention, and delivery indexes", async () => {
    const database = createDatabase();
    await applyPostgresMigrations(pgliteMigrationClient(database));

    const indexes = await database.query<{ indexname: string }>(
      `SELECT indexname
         FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname = ANY($1::text[])
        ORDER BY indexname`,
      [EXPECTED_INDEXES],
    );

    expect(indexes.rows.map(({ indexname }) => indexname)).toEqual(
      [...EXPECTED_INDEXES].sort(),
    );

    const tenantColumns = await database.query<{
      column_name: string;
      table_name: string;
    }>(`
      SELECT table_name, column_name
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name IN (
           'principals', 'cases', 'jobs', 'idempotency_keys', 'run_evidence',
           'artifacts', 'outbox_events', 'audit_events', 'quota_ledger',
           'deletion_requests', 'github_installation_states',
           'github_installations', 'github_repositories'
         )
         AND column_name = 'tenant_id'
       ORDER BY table_name
    `);
    expect(tenantColumns.rows).toHaveLength(13);

    const retentionColumns = await database.query<{ table_name: string }>(`
      SELECT table_name
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND column_name IN ('retention_until', 'expires_at')
         AND table_name IN (
           'principals', 'cases', 'jobs', 'idempotency_keys', 'run_evidence',
           'artifacts', 'outbox_events', 'audit_events', 'quota_ledger',
           'deletion_requests', 'github_installation_states'
         )
       GROUP BY table_name
       ORDER BY table_name
    `);
    expect(retentionColumns.rows.map(({ table_name }) => table_name)).toEqual([
      "artifacts",
      "audit_events",
      "cases",
      "deletion_requests",
      "github_installation_states",
      "idempotency_keys",
      "jobs",
      "outbox_events",
      "principals",
      "quota_ledger",
      "run_evidence",
    ]);
  });

  it("rejects checksum drift for an already-applied migration", async () => {
    const database = createDatabase();
    const client = pgliteMigrationClient(database);
    const original = definePostgresMigration(
      "0001_test_checksum",
      "CREATE TABLE checksum_original (id text PRIMARY KEY);",
    );
    const changed = definePostgresMigration(
      original.id,
      "CREATE TABLE checksum_changed (id text PRIMARY KEY);",
    );

    await applyPostgresMigrations(client, [original]);

    await expect(applyPostgresMigrations(client, [changed])).rejects.toMatchObject({
      code: "MIGRATION_CHECKSUM_MISMATCH",
      migrationId: original.id,
    } satisfies Partial<MigrationIntegrityError>);
  });

  it("rolls back failed migration SQL without recording or leaking partial DDL", async () => {
    const database = createDatabase();
    const client = pgliteMigrationClient(database);
    const broken = definePostgresMigration(
      "0001_broken",
      `CREATE TABLE must_rollback (id text PRIMARY KEY);
       INSERT INTO table_that_does_not_exist (id) VALUES ('nope');`,
    );

    await expect(applyPostgresMigrations(client, [broken])).rejects.toThrow();

    const table = await database.query<{ name: string | null }>(
      "SELECT to_regclass('public.must_rollback')::text AS name",
    );
    const ledger = await database.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM reproforge_schema_migrations",
    );
    expect(table.rows[0]?.name).toBeNull();
    expect(ledger.rows[0]?.count).toBe("0");
  });

  it("upgrades a seeded first-migration fixture without changing its identity", async () => {
    const database = createDatabase();
    const client = pgliteMigrationClient(database);
    const migrations = loadPostgresMigrations();
    expect(migrations).toHaveLength(7);

    await applyPostgresMigrations(client, migrations.slice(0, 1));
    await database.exec(`
      INSERT INTO tenants (id) VALUES ('tenant_seeded');
      INSERT INTO cases (
        tenant_id, id, source_kind, source_descriptor
      ) VALUES (
        'tenant_seeded', 'case_seeded', 'trusted-sample',
        '{"sampleId":"cli-spaces"}'::jsonb
      );
      INSERT INTO jobs (tenant_id, id, case_id)
      VALUES ('tenant_seeded', 'job_seeded', 'case_seeded');
    `);

    const result = await applyPostgresMigrations(client, migrations);
    const seeded = await database.query<{
      case_id: string;
      job_id: string;
      tenant_id: string;
    }>(`
      SELECT c.tenant_id, c.id AS case_id, j.id AS job_id
        FROM cases c
        JOIN jobs j
          ON j.tenant_id = c.tenant_id AND j.case_id = c.id
       WHERE c.tenant_id = 'tenant_seeded'
    `);

    expect(result).toEqual({
      applied: migrations.slice(1).map(({ id }) => id),
      skipped: [migrations[0]?.id],
    });
    expect(seeded.rows).toEqual([
      {
        case_id: "case_seeded",
        job_id: "job_seeded",
        tenant_id: "tenant_seeded",
      },
    ]);
  });

  it("upgrades a seeded pre-queue-lifecycle event without losing its intent", async () => {
    const database = createDatabase();
    const client = pgliteMigrationClient(database);
    const migrations = loadPostgresMigrations();
    await applyPostgresMigrations(client, migrations.slice(0, 3));
    const payload = {
      caseId: "case_queue_upgrade",
      eventId: "event_queue_upgrade",
      jobId: "job_queue_upgrade",
      kind: "reproduction.requested",
      schemaVersion: "1.0",
      tenantId: "tenant_queue_upgrade",
    };
    await database.exec(`
      INSERT INTO tenants (id) VALUES ('tenant_queue_upgrade');
      INSERT INTO cases (tenant_id, id, source_kind, source_descriptor)
      VALUES (
        'tenant_queue_upgrade', 'case_queue_upgrade',
        'trusted-sample', '{}'::jsonb
      );
      INSERT INTO jobs (tenant_id, id, case_id)
      VALUES ('tenant_queue_upgrade', 'job_queue_upgrade', 'case_queue_upgrade');
    `);
    await database.query(
      `INSERT INTO outbox_events (
         tenant_id, id, case_id, job_id, kind, payload
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [
        payload.tenantId,
        payload.eventId,
        payload.caseId,
        payload.jobId,
        payload.kind,
        JSON.stringify(payload),
      ],
    );

    const result = await applyPostgresMigrations(client, migrations);
    const event = await database.query<{
      payload: unknown;
      status: string;
      updated: boolean;
      version: string;
    }>(
      `SELECT status, version::text,
              updated_at IS NOT NULL AS updated, payload
         FROM outbox_events
        WHERE tenant_id = 'tenant_queue_upgrade'`,
    );

    expect(result).toEqual({
      applied: migrations.slice(3).map(({ id }) => id),
      skipped: migrations.slice(0, 3).map(({ id }) => id),
    });
    expect(event.rows).toEqual([
      { payload, status: "PENDING", updated: true, version: "1" },
    ]);
  });

  it("enforces tenant references, states, idempotency, quotas, and versions", async () => {
    const database = createDatabase();
    await applyPostgresMigrations(pgliteMigrationClient(database));
    await database.exec(`
      INSERT INTO tenants (id) VALUES ('tenant_a'), ('tenant_b');
      INSERT INTO cases (tenant_id, id, source_kind, source_descriptor)
      VALUES (
        'tenant_a', 'case_a', 'trusted-sample',
        '{"sampleId":"cli-spaces"}'::jsonb
      );
      INSERT INTO jobs (tenant_id, id, case_id)
      VALUES ('tenant_a', 'job_a', 'case_a');
    `);

    await expect(
      database.query(
        "INSERT INTO jobs (tenant_id, id, case_id) VALUES ('tenant_b', 'job_cross', 'case_a')",
      ),
    ).rejects.toThrow();
    await expect(
      database.query(
        `INSERT INTO cases (tenant_id, id, source_kind, source_descriptor, state)
         VALUES ('tenant_a', 'case_bad_state', 'trusted-sample', '{}'::jsonb, 'MAGIC')`,
      ),
    ).rejects.toThrow();

    await database.query(
      `INSERT INTO idempotency_keys
        (tenant_id, caller_id, idempotency_key, command_hash, case_id, job_id)
       VALUES ('tenant_a', 'caller_a', 'key_a', $1, 'case_a', 'job_a')`,
      ["a".repeat(64)],
    );
    await expect(
      database.query(
        `INSERT INTO idempotency_keys
          (tenant_id, caller_id, idempotency_key, command_hash, case_id, job_id)
         VALUES ('tenant_a', 'caller_a', 'key_a', $1, 'case_a', 'job_a')`,
        ["b".repeat(64)],
      ),
    ).rejects.toThrow();
    await expect(
      database.query(
        `INSERT INTO quota_ledger
          (tenant_id, id, resource, window_start, window_end, reserved_amount, expires_at)
         VALUES (
           'tenant_a', 'quota_bad', 'active-jobs', now(), now() + interval '1 hour',
           -1, now() + interval '5 minutes'
         )`,
      ),
    ).rejects.toThrow();
    await expect(
      database.query(
        "UPDATE cases SET version = 3 WHERE tenant_id = 'tenant_a' AND id = 'case_a'",
      ),
    ).rejects.toThrow(/version/i);
    await expect(
      database.query(
        `UPDATE jobs
            SET state = 'SUCCEEDED', attempt = 1, version = 2
          WHERE tenant_id = 'tenant_a' AND id = 'job_a'`,
      ),
    ).rejects.toThrow(/transition/i);
    await expect(
      database.query(
        `INSERT INTO jobs (tenant_id, id, case_id, state)
         VALUES ('tenant_a', 'job_cancel_without_timestamps', 'case_a', 'CANCELLED')`,
      ),
    ).rejects.toThrow(/cancellation/i);

    await database.query(
      "UPDATE cases SET version = 2 WHERE tenant_id = 'tenant_a' AND id = 'case_a'",
    );
    const version = await database.query<{ version: string }>(
      "SELECT version::text FROM cases WHERE tenant_id = 'tenant_a' AND id = 'case_a'",
    );
    expect(version.rows[0]?.version).toBe("2");
  });

  it("keeps evidence and audit records append-only", async () => {
    const database = createDatabase();
    await applyPostgresMigrations(pgliteMigrationClient(database));
    await database.exec(`
      INSERT INTO tenants (id) VALUES ('tenant_a');
      INSERT INTO cases (tenant_id, id, source_kind, source_descriptor)
      VALUES ('tenant_a', 'case_a', 'trusted-sample', '{}'::jsonb);
      INSERT INTO jobs (
        tenant_id, id, case_id, state, attempt,
        lease_owner, lease_acquired_at, lease_expires_at
      ) VALUES (
        'tenant_a', 'job_a', 'case_a', 'RUNNING', 1,
        'worker_a', CURRENT_TIMESTAMP - interval '1 minute',
        CURRENT_TIMESTAMP + interval '1 hour'
      );
      INSERT INTO run_evidence (
        tenant_id, case_id, job_id, attempt, sequence, kind,
        environment, evidence, lease_owner
      ) VALUES (
        'tenant_a', 'case_a', 'job_a', 1, 1, 'positive-control',
        '{}'::jsonb, '{}'::jsonb, 'worker_a'
      );
      INSERT INTO audit_events (
        tenant_id, id, actor_id, action, target_type, target_id, outcome, metadata
      ) VALUES (
        'tenant_a', 'audit_a', 'principal_a', 'case.created', 'case', 'case_a',
        'success', '{}'::jsonb
      );
    `);

    await expect(
      database.query(
        "UPDATE run_evidence SET evidence = '{\"changed\":true}'::jsonb WHERE tenant_id = 'tenant_a'",
      ),
    ).rejects.toThrow(/append-only/i);
    await expect(
      database.query(
        `INSERT INTO run_evidence (
           tenant_id, case_id, job_id, attempt, sequence, kind,
           environment, evidence, lease_owner
         ) VALUES (
           'tenant_a', 'case_a', 'job_a', 1, 2, 'positive-control',
           '{}'::jsonb, '{}'::jsonb, 'worker_intruder'
         )`,
      ),
    ).rejects.toThrow(/lease owner/i);
    await expect(
      database.query(
        "DELETE FROM audit_events WHERE tenant_id = 'tenant_a' AND id = 'audit_a'",
      ),
    ).rejects.toThrow(/append-only/i);
    await expect(
      database.query(
        `INSERT INTO audit_events (
          tenant_id, id, actor_id, action, target_type, target_id, outcome, metadata
        ) VALUES (
          'tenant_a', 'audit_nested', 'principal_a', 'case.read', 'case', 'case_a',
          'success', '{"nested":{"secret":"synthetic"}}'::jsonb
        )`,
      ),
    ).rejects.toThrow();
  });

  it("requires an exact identifier-only outbox payload", async () => {
    const database = createDatabase();
    await applyPostgresMigrations(pgliteMigrationClient(database));
    await database.exec(`
      INSERT INTO tenants (id) VALUES ('tenant_a');
      INSERT INTO cases (tenant_id, id, source_kind, source_descriptor)
      VALUES ('tenant_a', 'case_a', 'trusted-sample', '{}'::jsonb);
      INSERT INTO jobs (tenant_id, id, case_id)
      VALUES ('tenant_a', 'job_a', 'case_a');
    `);

    const valid = {
      caseId: "case_a",
      eventId: "event_a",
      jobId: "job_a",
      kind: "reproduction.requested",
      schemaVersion: "1.0",
      tenantId: "tenant_a",
    };
    await database.query(
      `INSERT INTO outbox_events
        (tenant_id, id, case_id, job_id, kind, payload)
       VALUES ('tenant_a', 'event_a', 'case_a', 'job_a',
         'reproduction.requested', $1::jsonb)`,
      [JSON.stringify(valid)],
    );
    await expect(
      database.query(
        `INSERT INTO outbox_events
          (tenant_id, id, case_id, job_id, kind, payload)
         VALUES ('tenant_a', 'event_missing', 'case_a', 'job_a',
           'reproduction.requested', '{}'::jsonb)`,
      ),
    ).rejects.toThrow();
    await expect(
      database.query(
        `INSERT INTO outbox_events
          (tenant_id, id, case_id, job_id, kind, payload)
         VALUES ('tenant_a', 'event_secret', 'case_a', 'job_a',
           'reproduction.requested', $1::jsonb)`,
        [JSON.stringify({ ...valid, eventId: "event_secret", token: "synthetic" })],
      ),
    ).rejects.toThrow();
  });
});
