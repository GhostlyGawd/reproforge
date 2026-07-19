import { PGlite } from "@electric-sql/pglite";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { applyPostgresMigrations } from "@/infrastructure/postgres/migrations";

import { pgliteMigrationClient } from "./helpers/pglite-migration-client";

vi.setConfig({ hookTimeout: 30_000, testTimeout: 30_000 });

describe("Postgres durable-foundation constraint properties", () => {
  let database: PGlite;

  beforeAll(async () => {
    database = new PGlite();
    await applyPostgresMigrations(pgliteMigrationClient(database));
    await database.exec(`
      INSERT INTO tenants (id) VALUES ('tenant_property');
      INSERT INTO cases (tenant_id, id, source_kind, source_descriptor)
      VALUES ('tenant_property', 'case_property', 'trusted-sample', '{}'::jsonb);
    `);
  });

  afterAll(async () => {
    await database.close();
  });

  it("rejects every generated non-successor optimistic version", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: -10_000, max: 10_000 }).filter((value) => value !== 2),
        async (version) => {
          await expect(
            database.query(
              `UPDATE cases
                  SET version = $1
                WHERE tenant_id = 'tenant_property' AND id = 'case_property'`,
              [version],
            ),
          ).rejects.toThrow();

          const stored = await database.query<{ version: string }>(
            `SELECT version::text
               FROM cases
              WHERE tenant_id = 'tenant_property' AND id = 'case_property'`,
          );
          expect(stored.rows[0]?.version).toBe("1");
        },
      ),
      { numRuns: 250 },
    );
  });
});
