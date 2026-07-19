import {
  Pool,
  neonConfig,
  type PoolClient,
  type QueryResultRow,
} from "@neondatabase/serverless";
import WebSocket from "ws";

import type {
  PostgresDatabase,
  PostgresExecutor,
  PostgresQueryResult,
} from "./database";

type NeonQueryable = Pick<Pool | PoolClient, "query">;

export class NeonDatabaseConfigurationError extends Error {
  readonly code = "INVALID_DATABASE_CONFIGURATION";

  constructor() {
    super("The Neon database configuration is invalid");
    this.name = "NeonDatabaseConfigurationError";
  }
}

function validateConnectionString(connectionString: string): string {
  try {
    const parsed = new URL(connectionString);
    if (
      !["postgres:", "postgresql:"].includes(parsed.protocol) ||
      parsed.hostname.length === 0 ||
      parsed.username.length === 0
    ) {
      throw new Error("invalid");
    }
    return connectionString;
  } catch {
    throw new NeonDatabaseConfigurationError();
  }
}

function neonExecutor(queryable: NeonQueryable): PostgresExecutor {
  return {
    execute: async (sql) => {
      await queryable.query(sql);
    },
    query: async <Row extends Record<string, unknown>>(
      sql: string,
      parameters: readonly unknown[] = [],
    ): Promise<PostgresQueryResult<Row>> => {
      const result = await queryable.query<Row & QueryResultRow>(sql, [
        ...parameters,
      ]);
      return {
        affectedRows: result.rowCount ?? 0,
        rows: result.rows,
      };
    },
  };
}

export class NeonPostgresDatabase implements PostgresDatabase {
  private readonly executor: PostgresExecutor;

  constructor(private readonly pool: Pool) {
    this.executor = neonExecutor(pool);
  }

  execute(sql: string): Promise<void> {
    return this.executor.execute(sql);
  }

  query<Row extends Record<string, unknown>>(
    sql: string,
    parameters: readonly unknown[] = [],
  ): Promise<PostgresQueryResult<Row>> {
    return this.executor.query<Row>(sql, parameters);
  }

  async transaction<T>(
    operation: (executor: PostgresExecutor) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await operation(neonExecutor(client));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export function createNeonPostgresDatabase(
  connectionString: string,
): NeonPostgresDatabase {
  neonConfig.webSocketConstructor = WebSocket;
  return new NeonPostgresDatabase(
    new Pool({
      allowExitOnIdle: true,
      connectionString: validateConnectionString(connectionString),
      max: 4,
      maxUses: 100,
    }),
  );
}
