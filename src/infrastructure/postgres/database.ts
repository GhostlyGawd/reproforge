export type PostgresQueryResult<Row extends Record<string, unknown>> = {
  affectedRows?: number;
  rows: Row[];
};

export interface PostgresExecutor {
  execute(sql: string): Promise<void>;
  query<Row extends Record<string, unknown>>(
    sql: string,
    parameters?: readonly unknown[],
  ): Promise<PostgresQueryResult<Row>>;
}

export interface PostgresDatabase extends PostgresExecutor {
  transaction<T>(operation: (executor: PostgresExecutor) => Promise<T>): Promise<T>;
}

function postgresErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

function isRetryableTransactionError(error: unknown): boolean {
  return ["40001", "40P01"].includes(postgresErrorCode(error) ?? "");
}

export async function runSerializableTransaction<T>(
  database: PostgresDatabase,
  operation: (executor: PostgresExecutor) => Promise<T>,
  maxAttempts = 3,
): Promise<T> {
  let attempt = 0;
  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      return await database.transaction(async (executor) => {
        await executor.query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");
        return operation(executor);
      });
    } catch (error) {
      if (attempt >= maxAttempts || !isRetryableTransactionError(error)) {
        throw error;
      }
    }
  }
  throw new Error("Serializable transaction retry bound was exhausted");
}
