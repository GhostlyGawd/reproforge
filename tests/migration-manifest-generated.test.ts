import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { loadPostgresMigrations } from "@/infrastructure/postgres/migrations";

describe("generated Postgres migration manifest", () => {
  it("matches every canonical SQL source byte-for-byte", () => {
    for (const migration of loadPostgresMigrations()) {
      const source = readFileSync(
        new URL(
          `../src/infrastructure/postgres/migrations/${migration.id}.sql`,
          import.meta.url,
        ),
        "utf8",
      ).trim();
      expect(migration.sql).toBe(source);
    }
  });
});
