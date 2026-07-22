import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { PostgresPrincipalDirectory } from "@/infrastructure/identity/postgres-principal-directory";
import { applyPostgresMigrations } from "@/infrastructure/postgres/migrations";
import { pgliteMigrationClient } from "./helpers/pglite-migration-client";
import { pglitePostgresDatabase } from "./helpers/pglite-postgres-database";

vi.setConfig({ hookTimeout: 30_000, testTimeout: 30_000 });

let database: PGlite;
let directory: PostgresPrincipalDirectory;

beforeAll(async () => {
  database = new PGlite();
  await applyPostgresMigrations(pgliteMigrationClient(database));
  directory = new PostgresPrincipalDirectory(
    pglitePostgresDatabase(database),
  );
  await database.query(
    `INSERT INTO tenants (id, status) VALUES
       ('tenant-active', 'ACTIVE'),
       ('tenant-suspended', 'SUSPENDED')`,
  );
  await database.query(
    `INSERT INTO principals (
       tenant_id, id, provider, issuer, external_subject
     ) VALUES
       ('tenant-active', 'principal-active', 'auth0', $1, 'auth0|active'),
       ('tenant-suspended', 'principal-suspended', 'auth0', $1, 'auth0|suspended')`,
    ["https://issuer.reproforge.test/"],
  );
});

afterAll(async () => {
  await database.close();
});

describe("Postgres principal directory", () => {
  it("resolves an exact issuer/subject pair with its current tenant status", async () => {
    await expect(
      directory.resolve({
        issuer: "https://issuer.reproforge.test/",
        subject: "auth0|active",
      }),
    ).resolves.toEqual({
      principalId: "principal-active",
      status: "ACTIVE",
      tenantId: "tenant-active",
    });
    await expect(
      directory.resolve({
        issuer: "https://issuer.reproforge.test/",
        subject: "auth0|suspended",
      }),
    ).resolves.toMatchObject({ status: "SUSPENDED" });
  });

  it("does not match a different issuer, subject, or unknown principal", async () => {
    await expect(
      directory.resolve({
        issuer: "https://other.reproforge.test/",
        subject: "auth0|active",
      }),
    ).resolves.toBeNull();
    await expect(
      directory.resolve({
        issuer: "https://issuer.reproforge.test/",
        subject: "auth0|unknown",
      }),
    ).resolves.toBeNull();
  });
});
