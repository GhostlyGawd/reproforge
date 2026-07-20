import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { VerifiedGitHubInstallation } from "@/github/callback";
import {
  PostgresGitHubAuthorizationStore,
} from "@/infrastructure/github/postgres-github-authorization-store";
import { applyPostgresMigrations } from "@/infrastructure/postgres/migrations";
import { pgliteMigrationClient } from "./helpers/pglite-migration-client";
import { pglitePostgresDatabase } from "./helpers/pglite-postgres-database";

const actor = {
  principalId: "principal-alpha",
  tenantId: "tenant-alpha",
};

const installation: VerifiedGitHubInstallation = {
  accountId: 9001,
  accountLogin: "synthetic-owner",
  installationId: 7001,
  permissions: {
    contents: "read",
    issues: "read",
    metadata: "read",
  },
  repositories: [
    {
      defaultBranch: "main",
      fullName: "synthetic-owner/private-canary",
      private: true,
      repositoryId: 8001,
    },
    {
      defaultBranch: "trunk",
      fullName: "synthetic-owner/public-canary",
      private: false,
      repositoryId: 8002,
    },
  ],
  repositorySelection: "selected",
};

describe("Postgres GitHub authorization store", () => {
  let database: PGlite;
  let store: PostgresGitHubAuthorizationStore;

  beforeEach(async () => {
    database = new PGlite();
    await database.waitReady;
    await applyPostgresMigrations(pgliteMigrationClient(database));
    await database.exec(`
      INSERT INTO tenants (id) VALUES ('tenant-alpha'), ('tenant-beta');
      INSERT INTO principals (
        tenant_id, id, provider, issuer, external_subject
      ) VALUES (
        'tenant-alpha', 'principal-alpha', 'auth0',
        'https://issuer.example/', 'auth0|alpha'
      ), (
        'tenant-beta', 'principal-beta', 'auth0',
        'https://issuer.example/', 'auth0|beta'
      );
    `);
    let sequence = 0;
    store = new PostgresGitHubAuthorizationStore(
      pglitePostgresDatabase(database),
      { repositoryId: () => `repo_${++sequence}` },
    );
  });

  afterEach(async () => {
    await database.close();
  });

  it("stores only a hashed, actor-bound installation state and consumes it once", async () => {
    const record = {
      ...actor,
      consumedAt: null,
      createdAt: "2026-07-20T00:00:00.000Z",
      expiresAt: "2026-07-20T00:10:00.000Z",
      stateHash: "a".repeat(64),
    };
    await store.create(record);

    await expect(
      store.consume({
        ...actor,
        at: "2026-07-20T00:01:00.000Z",
        stateHash: record.stateHash,
      }),
    ).resolves.toMatchObject({ consumedAt: "2026-07-20T00:01:00.000Z" });
    await expect(
      store.consume({
        ...actor,
        at: "2026-07-20T00:02:00.000Z",
        stateHash: record.stateHash,
      }),
    ).resolves.toBeNull();

    const stored = await database.query<Record<string, unknown>>(
      "SELECT * FROM github_installation_states",
    );
    expect(JSON.stringify(stored.rows)).not.toMatch(/synthetic-github-code|access_token/);
    expect(stored.rows[0]).toMatchObject({ state_hash: record.stateHash });
  });

  it("binds repository metadata to one tenant without persisting credentials", async () => {
    await store.bind(actor, installation);

    const alpha = await store.listRepositories({
      limit: 10,
      tenantId: actor.tenantId,
    });
    expect(alpha.repositories).toEqual([
      expect.objectContaining({
        fullName: "synthetic-owner/private-canary",
        repositoryId: "repo_1",
      }),
      expect.objectContaining({
        fullName: "synthetic-owner/public-canary",
        repositoryId: "repo_2",
      }),
    ]);
    await expect(
      store.listRepositories({ limit: 10, tenantId: "tenant-beta" }),
    ).resolves.toEqual({ nextCursor: null, repositories: [] });
    await expect(
      store.findRepository("tenant-beta", "repo_1"),
    ).resolves.toBeNull();
    await expect(
      store.findRepository(actor.tenantId, "repo_1"),
    ).resolves.toMatchObject({
      installationId: 7001,
      providerRepositoryId: 8001,
      status: "ACTIVE",
    });

    const serialized = JSON.stringify(
      await database.query<Record<string, unknown>>(
        `SELECT i.*, r.*
           FROM github_installations i
           JOIN github_repositories r USING (tenant_id, installation_id)`,
      ),
    );
    expect(serialized).not.toMatch(/token|secret|private_key|oauth/i);
  });

  it("refuses to bind one provider installation to a different tenant", async () => {
    await store.bind(actor, installation);
    await expect(
      store.bind(
        { principalId: "principal-beta", tenantId: "tenant-beta" },
        installation,
      ),
    ).rejects.toThrow();
  });

  it("applies installation suspension and removal exactly once per webhook delivery", async () => {
    await store.bind(actor, installation);
    const suspended = {
      deliveryId: "delivery-suspend-1",
      event: "installation" as const,
      payload: {
        action: "suspended",
        installation: {
          id: installation.installationId,
          permissions: installation.permissions,
          suspended_at: "2026-07-20T00:03:00.000Z",
        },
      },
    };

    await expect(store.processWebhook(suspended)).resolves.toBe("accepted");
    await expect(store.processWebhook(suspended)).resolves.toBe("duplicate");
    await expect(
      store.findRepository(actor.tenantId, "repo_1"),
    ).resolves.toMatchObject({ status: "SUSPENDED" });

    await expect(
      store.processWebhook({
        deliveryId: "delivery-delete-1",
        event: "installation",
        payload: {
          action: "deleted",
          installation: {
            id: installation.installationId,
            permissions: installation.permissions,
            suspended_at: null,
          },
        },
      }),
    ).resolves.toBe("accepted");
    await expect(
      store.findRepository(actor.tenantId, "repo_1"),
    ).resolves.toMatchObject({ status: "REMOVED" });

    const deliveries = await database.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM github_webhook_deliveries",
    );
    expect(deliveries.rows[0]?.count).toBe("2");
    const audits = await database.query<{ action: string; outcome: string }>(
      `SELECT action, outcome
         FROM audit_events
        WHERE tenant_id = $1
        ORDER BY occurred_at, action`,
      [actor.tenantId],
    );
    expect(audits.rows).toEqual(
      expect.arrayContaining([
        { action: "github.installation-linked", outcome: "success" },
        { action: "github.installation-removed", outcome: "success" },
        { action: "github.installation-suspended", outcome: "success" },
      ]),
    );
    expect(JSON.stringify(audits.rows)).not.toMatch(/token|secret|private_key/i);
  });

  it("fails closed when a webhook reports permission drift", async () => {
    await store.bind(actor, installation);
    await expect(
      store.processWebhook({
        deliveryId: "delivery-permissions-1",
        event: "installation",
        payload: {
          action: "new_permissions_accepted",
          installation: {
            id: installation.installationId,
            permissions: {
              ...installation.permissions,
              contents: "write",
            },
            suspended_at: null,
          },
        },
      }),
    ).resolves.toBe("accepted");
    await expect(
      store.findRepository(actor.tenantId, "repo_1"),
    ).resolves.toMatchObject({ status: "SUSPENDED" });
  });

  it("updates selected repositories idempotently from repository lifecycle events", async () => {
    await store.bind(actor, installation);
    await expect(
      store.processWebhook({
        deliveryId: "delivery-repositories-1",
        event: "installation_repositories",
        payload: {
          action: "removed",
          installation: { id: installation.installationId },
          repositories_added: [],
          repositories_removed: [{ id: 8001 }],
        },
      }),
    ).resolves.toBe("accepted");
    await expect(
      store.findRepository(actor.tenantId, "repo_1"),
    ).resolves.toMatchObject({ status: "REMOVED" });
    await expect(
      store.findRepository(actor.tenantId, "repo_2"),
    ).resolves.toMatchObject({ status: "ACTIVE" });
  });
});
