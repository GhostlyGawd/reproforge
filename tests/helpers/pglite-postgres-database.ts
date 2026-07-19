import type { PGlite } from "@electric-sql/pglite";

import type {
  PostgresDatabase,
  PostgresExecutor,
  PostgresQueryResult,
} from "@/infrastructure/postgres/database";

type PGliteQuerySurface = Pick<PGlite, "exec" | "query">;

function executor(surface: PGliteQuerySurface): PostgresExecutor {
  return {
    execute: async (sql) => {
      await surface.exec(sql);
    },
    query: async <Row extends Record<string, unknown>>(
      sql: string,
      parameters: readonly unknown[] = [],
    ): Promise<PostgresQueryResult<Row>> => {
      const result = await surface.query<Row>(sql, [...parameters]);
      return { affectedRows: result.affectedRows ?? 0, rows: result.rows };
    },
  };
}

export function pglitePostgresDatabase(database: PGlite): PostgresDatabase {
  return {
    ...executor(database),
    transaction: async (operation) =>
      database.transaction(async (transaction) =>
        operation(executor(transaction as PGliteQuerySurface)),
      ),
  };
}
