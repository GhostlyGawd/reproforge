import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import type {
  PostgresDatabase,
  PostgresExecutor,
  PostgresQueryResult as DatabaseQueryResult,
} from "./database";

export type PostgresQueryResult<Row extends Record<string, unknown>> =
  DatabaseQueryResult<Row>;
export type PostgresMigrationTransaction = PostgresExecutor;
export type PostgresMigrationClient = PostgresDatabase;

export type PostgresMigration = Readonly<{
  checksum: string;
  id: string;
  sql: string;
}>;

export type PostgresMigrationResult = Readonly<{
  applied: string[];
  skipped: string[];
}>;

export class MigrationIntegrityError extends Error {
  readonly code:
    | "INVALID_MIGRATION_MANIFEST"
    | "MIGRATION_CHECKSUM_MISMATCH";
  readonly migrationId?: string;

  constructor(input: {
    code: MigrationIntegrityError["code"];
    message: string;
    migrationId?: string;
  }) {
    super(input.message);
    this.name = "MigrationIntegrityError";
    this.code = input.code;
    this.migrationId = input.migrationId;
  }
}

const MIGRATION_LEDGER_SQL = `
CREATE TABLE IF NOT EXISTS reproforge_schema_migrations (
  id text PRIMARY KEY,
  checksum char(64) NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT reproforge_schema_migrations_id_format
    CHECK (id ~ '^[0-9]{4}_[a-z0-9_]+$'),
  CONSTRAINT reproforge_schema_migrations_checksum_format
    CHECK (checksum ~ '^[a-f0-9]{64}$')
);`;

const migrationSources = [
  {
    id: "0001_durable_foundation",
    url: new URL("./migrations/0001_durable_foundation.sql", import.meta.url),
  },
  {
    id: "0002_durable_invariants",
    url: new URL("./migrations/0002_durable_invariants.sql", import.meta.url),
  },
  {
    id: "0003_artifact_lifecycle",
    url: new URL("./migrations/0003_artifact_lifecycle.sql", import.meta.url),
  },
  {
    id: "0004_queue_delivery",
    url: new URL("./migrations/0004_queue_delivery.sql", import.meta.url),
  },
  {
    id: "0005_governance_lifecycle",
    url: new URL("./migrations/0005_governance_lifecycle.sql", import.meta.url),
  },
] as const;

export function definePostgresMigration(
  id: string,
  sql: string,
): PostgresMigration {
  const normalizedSql = sql.trim();
  if (!/^[0-9]{4}_[a-z0-9_]+$/.test(id) || normalizedSql.length === 0) {
    throw new MigrationIntegrityError({
      code: "INVALID_MIGRATION_MANIFEST",
      message: `Invalid Postgres migration manifest entry: ${id}`,
      migrationId: id,
    });
  }
  return Object.freeze({
    checksum: createHash("sha256").update(normalizedSql).digest("hex"),
    id,
    sql: normalizedSql,
  });
}

export function loadPostgresMigrations(): PostgresMigration[] {
  return migrationSources.map(({ id, url }) =>
    definePostgresMigration(id, readFileSync(url, "utf8")),
  );
}

function validateManifest(migrations: readonly PostgresMigration[]): void {
  const ids = migrations.map(({ id }) => id);
  const sortedIds = [...ids].sort();
  if (
    new Set(ids).size !== ids.length ||
    ids.some((id, index) => id !== sortedIds[index])
  ) {
    throw new MigrationIntegrityError({
      code: "INVALID_MIGRATION_MANIFEST",
      message: "Postgres migrations must have unique, ascending identifiers",
    });
  }
  for (const migration of migrations) {
    const expected = definePostgresMigration(migration.id, migration.sql).checksum;
    if (migration.checksum !== expected) {
      throw new MigrationIntegrityError({
        code: "INVALID_MIGRATION_MANIFEST",
        message: `Postgres migration checksum is invalid: ${migration.id}`,
        migrationId: migration.id,
      });
    }
  }
}

export async function applyPostgresMigrations(
  client: PostgresMigrationClient,
  migrations: readonly PostgresMigration[] = loadPostgresMigrations(),
): Promise<PostgresMigrationResult> {
  validateManifest(migrations);
  await client.execute(MIGRATION_LEDGER_SQL);

  const result: PostgresMigrationResult = { applied: [], skipped: [] };
  for (const migration of migrations) {
    const applied = await client.transaction(async (transaction) => {
      await transaction.query(
        "SELECT pg_advisory_xact_lock(1381125697) AS migration_lock",
      );
      const existing = await transaction.query<{ checksum: string }>(
        "SELECT checksum FROM reproforge_schema_migrations WHERE id = $1",
        [migration.id],
      );
      const recordedChecksum = existing.rows[0]?.checksum;
      if (recordedChecksum !== undefined) {
        if (recordedChecksum !== migration.checksum) {
          throw new MigrationIntegrityError({
            code: "MIGRATION_CHECKSUM_MISMATCH",
            message: `Applied Postgres migration has changed: ${migration.id}`,
            migrationId: migration.id,
          });
        }
        return false;
      }

      await transaction.execute(migration.sql);
      await transaction.query(
        `INSERT INTO reproforge_schema_migrations (id, checksum)
         VALUES ($1, $2)`,
        [migration.id, migration.checksum],
      );
      return true;
    });

    if (applied) result.applied.push(migration.id);
    else result.skipped.push(migration.id);
  }
  return result;
}
