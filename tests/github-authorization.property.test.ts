import { PGlite } from "@electric-sql/pglite";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  reduceGitHubAuthorizationState,
  type GitHubAuthorizationState,
} from "@/github/authorization-state";
import {
  createGitHubInstallationCallbackHandler,
  type GitHubInstallationVerifier,
} from "@/github/callback";
import { createGitHubInstallHandler } from "@/github/install-route";
import {
  InMemoryGitHubInstallationStateStore,
  createGitHubInstallationAuthorization,
} from "@/github/installation-state";
import { PostgresGitHubAuthorizationStore } from "@/infrastructure/github/postgres-github-authorization-store";
import { applyPostgresMigrations } from "@/infrastructure/postgres/migrations";

import { pgliteMigrationClient } from "./helpers/pglite-migration-client";
import { pglitePostgresDatabase } from "./helpers/pglite-postgres-database";

const actor = { principalId: "principal-alpha", tenantId: "tenant-alpha" };
const now = new Date("2026-07-20T00:00:00.000Z");

describe("GitHub authorization properties", () => {
  it("makes webhook duplication and reordering converge over 300 generated event sets", () => {
    const event = fc.record({
      at: fc.integer({ min: 0, max: 10_000 }).map((offset) =>
        new Date(now.getTime() + offset * 1_000).toISOString(),
      ),
      status: fc.constantFrom("ACTIVE", "SUSPENDED", "REMOVED" as const),
    });
    fc.assert(
      fc.property(fc.array(event, { maxLength: 30 }), (events) => {
        const initial: GitHubAuthorizationState = {
          providerUpdatedAt: null,
          status: "ACTIVE",
        };
        const apply = (sequence: typeof events) =>
          sequence.reduce(reduceGitHubAuthorizationState, initial);
        const duplicated = events.flatMap((item) => [item, item]);
        expect(apply(duplicated)).toEqual(apply(events));
        expect(apply([...events].reverse())).toEqual(apply(events));
      }),
      { numRuns: 300 },
    );
  });

  it("rejects replay, mutation, expiry, actor mismatch, and installation substitution over 300 callbacks", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uint8Array({ minLength: 32, maxLength: 32 }),
        fc.constantFrom(
          "replay",
          "mutation",
          "expiry",
          "actor-mismatch",
          "installation-substitution",
        ),
        async (entropy, mode) => {
          const states = new InMemoryGitHubInstallationStateStore();
          const authorization = await createGitHubInstallationAuthorization({
            actor,
            appSlug: "reproforge-development",
            clock: { now: () => now },
            randomBytes: () => entropy,
            states,
          });
          const verifier: GitHubInstallationVerifier = {
            verify: vi.fn(async () => ({
              accountId: 9001,
              accountLogin: "synthetic-owner",
              installationId:
                mode === "installation-substitution" ? 7002 : 7001,
              permissions: {
                contents: "read" as const,
                issues: "read" as const,
                metadata: "read" as const,
              },
              repositorySelection: "selected" as const,
            })),
          };
          const bind = vi.fn(async () => undefined);
          const callbackActor =
            mode === "actor-mismatch"
              ? { ...actor, tenantId: "tenant-beta" }
              : actor;
          const handler = createGitHubInstallationCallbackHandler({
            actor: async () => callbackActor,
            bind,
            clock: {
              now: () =>
                mode === "expiry"
                  ? new Date(now.getTime() + 11 * 60_000)
                  : new Date(now.getTime() + 60_000),
            },
            states,
            verifier,
          });
          const state =
            mode === "mutation"
              ? `${authorization.state[0] === "A" ? "B" : "A"}${authorization.state.slice(1)}`
              : authorization.state;
          const request = new Request(
            `https://reproforge.example/api/github/callback?code=synthetic-code&installation_id=7001&state=${state}`,
          );
          const first = await handler(request);
          if (mode === "replay") {
            expect(first.headers.get("location")).toContain("github=connected");
            expect((await handler(request)).headers.get("location")).toContain(
              "github=invalid",
            );
            expect(bind).toHaveBeenCalledTimes(1);
          } else {
            expect(first.headers.get("location")).toContain("github=invalid");
            expect(bind).not.toHaveBeenCalled();
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it("never reflects arbitrary registered secrets through the install HTTP boundary", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.stringMatching(/^[A-Za-z0-9_-]{16,64}$/),
        async (secret) => {
          const response = await createGitHubInstallHandler({
            actor: async () => {
              throw new Error(`ghs_${secret}`);
            },
            appSlug: "reproforge-development",
            baseUrl: "https://reproforge.example/",
            states: new InMemoryGitHubInstallationStateStore(),
          })();
          const serialized = JSON.stringify({
            body: await response.text(),
            headers: Object.fromEntries(response.headers),
            status: response.status,
          });
          expect(serialized).not.toContain(secret);
          expect(serialized).not.toContain(`ghs_${secret}`);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("Postgres cross-tenant GitHub authorization property", () => {
  let database: PGlite;
  let store: PostgresGitHubAuthorizationStore;

  beforeAll(async () => {
    database = new PGlite();
    await database.waitReady;
    await applyPostgresMigrations(pgliteMigrationClient(database));
    await database.exec(`
      INSERT INTO tenants (id) VALUES ('tenant-alpha'), ('tenant-beta');
      INSERT INTO principals (tenant_id, id, provider, issuer, external_subject)
      VALUES
        ('tenant-alpha', 'principal-alpha', 'auth0', 'https://issuer.example/', 'auth0|alpha'),
        ('tenant-beta', 'principal-beta', 'auth0', 'https://issuer.example/', 'auth0|beta');
    `);
    store = new PostgresGitHubAuthorizationStore(
      pglitePostgresDatabase(database),
      { repositoryId: () => "repo_alpha" },
    );
    await store.bind(actor, {
      accountId: 9001,
      accountLogin: "synthetic-owner",
      installationId: 7001,
      permissions: { contents: "read", issues: "read", metadata: "read" },
      repositories: [{
        defaultBranch: "main",
        fullName: "synthetic-owner/private-canary",
        private: true,
        repositoryId: 8001,
      }],
      repositorySelection: "selected",
    });
  });

  afterAll(async () => {
    await database.close();
  });

  it("never reveals another tenant's repository over 300 generated lookups", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,40}$/),
        async (candidate) => {
          await expect(
            store.findRepository("tenant-beta", candidate),
          ).resolves.toBeNull();
        },
      ),
      { numRuns: 300 },
    );
  });
});
