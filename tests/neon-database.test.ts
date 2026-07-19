import type { Pool } from "@neondatabase/serverless";
import { describe, expect, it, vi } from "vitest";

import {
  createNeonPostgresDatabase,
  NeonDatabaseConfigurationError,
  NeonPostgresDatabase,
} from "@/infrastructure/postgres/neon-database";

describe("Neon Postgres database adapter", () => {
  it("commits an interactive transaction and always releases its client", async () => {
    const statements: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        statements.push(sql);
        return { rowCount: 1, rows: [{ value: 1 }] };
      }),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn(async () => client),
      end: vi.fn(async () => undefined),
      query: vi.fn(),
    } as unknown as Pool;
    const database = new NeonPostgresDatabase(pool);

    await expect(
      database.transaction(async (executor) => {
        const result = await executor.query<{ value: number }>("SELECT 1");
        return result.rows[0]?.value;
      }),
    ).resolves.toBe(1);
    expect(statements).toEqual(["BEGIN", "SELECT 1", "COMMIT"]);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("rolls back a failed transaction and preserves the original error", async () => {
    const statements: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        statements.push(sql);
        return { rowCount: 0, rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn(async () => client),
      end: vi.fn(async () => undefined),
      query: vi.fn(),
    } as unknown as Pool;
    const database = new NeonPostgresDatabase(pool);

    await expect(
      database.transaction(async () => {
        throw new Error("synthetic operation failure");
      }),
    ).rejects.toThrow("synthetic operation failure");
    expect(statements).toEqual(["BEGIN", "ROLLBACK"]);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("fails configuration without echoing a connection secret", () => {
    const secret = "synthetic-database-password";
    expect(() => createNeonPostgresDatabase(`https://user:${secret}@example.com/db`))
      .toThrow(NeonDatabaseConfigurationError);
    try {
      createNeonPostgresDatabase(`https://user:${secret}@example.com/db`);
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });
});
