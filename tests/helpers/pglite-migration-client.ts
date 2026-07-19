import type { PGlite } from "@electric-sql/pglite";

import type {
  PostgresMigrationClient,
  PostgresMigrationTransaction,
  PostgresQueryResult,
} from "@/infrastructure/postgres/migrations";

type PGliteQuerySurface = Pick<PGlite, "exec" | "query">;

function transactionAdapter(
  surface: PGliteQuerySurface,
): PostgresMigrationTransaction {
  return {
    execute: async (sql) => {
      await surface.exec(sql);
    },
    query: async <Row extends Record<string, unknown>>(
      sql: string,
      parameters: readonly unknown[] = [],
    ): Promise<PostgresQueryResult<Row>> => {
      const result = await surface.query<Row>(sql, [...parameters]);
      return { rows: result.rows };
    },
  };
}

export function pgliteMigrationClient(
  database: PGlite,
): PostgresMigrationClient {
  return {
    ...transactionAdapter(database),
    transaction: async (operation) =>
      database.transaction(async (transaction) =>
        operation(transactionAdapter(transaction as PGliteQuerySurface)),
      ),
  };
}
