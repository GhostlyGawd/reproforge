import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { createRuntimeHealthService } from "@/infrastructure/operations/runtime-health";
import {
  InMemoryOperationalMetrics,
  JsonOperationalLogger,
} from "@/infrastructure/operations/observability";

const validPrivateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ format: "pem", type: "pkcs8" })
  .toString();

function observability() {
  const lines: string[] = [];
  return {
    lines,
    logger: new JsonOperationalLogger({
      sink: {
        error: (line) => lines.push(line),
        info: (line) => lines.push(line),
      },
    }),
    metrics: new InMemoryOperationalMetrics(),
  };
}

function completeHostedEnvironment(): Record<string, string> {
  return {
    APP_BASE_URL: "https://reproforge.example",
    AUTH0_CLIENT_ID: "synthetic-client-id",
    AUTH0_CLIENT_SECRET: "synthetic-client-secret",
    AUTH0_DOMAIN: "tenant.us.auth0.com",
    AUTH0_SECRET: "a".repeat(64),
    BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_synthetic",
    DATABASE_URL: "postgresql://user:secret@example.invalid/db",
    GITHUB_APP_CLIENT_ID: "Iv1.synthetic-client",
    GITHUB_APP_CLIENT_SECRET: "synthetic-client-secret-123456",
    GITHUB_APP_ID: "12345",
    GITHUB_APP_PRIVATE_KEY: validPrivateKey,
    GITHUB_APP_SLUG: "reproforge-development",
    GITHUB_WEBHOOK_SECRET: "synthetic-webhook-secret-with-entropy",
    REPROFORGE_BASE_URL: "https://reproforge.example",
    REPROFORGE_OAUTH_TENANT_CLAIM:
      "https://reproforge.example/tenant_id",
    REPROFORGE_RUNTIME_MODE: "preview",
  };
}

describe("runtime health composition", () => {
  it("fails hosted readiness without silently substituting local providers", async () => {
    const telemetry = observability();
    const health = createRuntimeHealthService({
      clock: { now: () => new Date("2026-07-19T20:00:00.000Z") },
      environment: {
        DATABASE_URL: "postgresql://user:highly-sensitive@example.invalid/db",
        REPROFORGE_RUNTIME_MODE: "production",
      },
      ...telemetry,
    });

    await expect(health.readiness()).resolves.toMatchObject({
      status: "unavailable",
      checks: [
        {
          code: "INVALID_RUNTIME_CONFIGURATION",
          component: "configuration",
          status: "unavailable",
        },
      ],
    });
    await expect(health.liveness()).resolves.toMatchObject({ status: "ready" });
    const serialized = JSON.stringify(telemetry.lines);
    expect(serialized).not.toContain("highly-sensitive");
    expect(serialized).not.toContain("postgresql://");
    expect(serialized).not.toContain("LOCAL_");
  });

  it("reports explicit local providers in test mode without network calls", async () => {
    const telemetry = observability();
    const health = createRuntimeHealthService({
      clock: { now: () => new Date("2026-07-19T20:00:00.000Z") },
      environment: { REPROFORGE_RUNTIME_MODE: "test" },
      ...telemetry,
    });

    await expect(health.readiness()).resolves.toMatchObject({
      status: "ready",
      checks: [
        { code: "LOCAL_DATABASE_READY", component: "database" },
        { code: "LOCAL_ARTIFACT_STORE_READY", component: "artifact-store" },
        { code: "LOCAL_QUEUE_READY", component: "queue" },
      ],
    });
  });

  it("fails hosted readiness before provider access when product auth is incomplete", async () => {
    const telemetry = observability();
    const providerCheck = vi.fn(async () => ({
      code: "DATABASE_READY",
      status: "ready" as const,
    }));
    const health = createRuntimeHealthService({
      clock: { now: () => new Date("2026-07-19T20:00:00.000Z") },
      environment: {
        BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_synthetic",
        DATABASE_URL: "postgresql://user:secret@example.invalid/db",
        REPROFORGE_BASE_URL: "https://reproforge.example",
        REPROFORGE_RUNTIME_MODE: "preview",
      },
      hostedProbes: {
        database: { check: providerCheck, component: "database" },
      },
      ...telemetry,
    });

    await expect(health.readiness()).resolves.toMatchObject({
      checks: [
        {
          code: "INVALID_WEB_AUTHENTICATION_CONFIGURATION",
          component: "configuration",
          status: "unavailable",
        },
      ],
      status: "unavailable",
    });
    expect(providerCheck).not.toHaveBeenCalled();
  });

  it.each([
    [
      "web authentication",
      { AUTH0_SECRET: "not-a-valid-cookie-secret" },
      "INVALID_WEB_AUTHENTICATION_CONFIGURATION",
    ],
    [
      "OAuth",
      { REPROFORGE_BASE_URL: "https://reproforge.example/application" },
      "INVALID_OAUTH_CONFIGURATION",
    ],
    [
      "GitHub",
      { GITHUB_APP_SLUG: "Not A Valid GitHub App Slug" },
      "INVALID_GITHUB_CONFIGURATION",
    ],
    [
      "hosted origin alignment",
      { APP_BASE_URL: "https://account.reproforge.example" },
      "HOSTED_ORIGIN_MISMATCH",
    ],
  ])(
    "reports a non-secret code for invalid %s configuration",
    async (_boundary, override, expectedCode) => {
      const telemetry = observability();
      const providerCheck = vi.fn(async () => ({
        code: "DATABASE_READY",
        status: "ready" as const,
      }));
      const health = createRuntimeHealthService({
        clock: { now: () => new Date("2026-07-19T20:00:00.000Z") },
        environment: {
          ...completeHostedEnvironment(),
          ...override,
        },
        hostedProbes: {
          database: { check: providerCheck, component: "database" },
        },
        ...telemetry,
      });

      await expect(health.readiness()).resolves.toMatchObject({
        checks: [
          {
            code: expectedCode,
            component: "configuration",
            status: "unavailable",
          },
        ],
        status: "unavailable",
      });
      expect(providerCheck).not.toHaveBeenCalled();
      expect(JSON.stringify(telemetry.lines)).not.toContain(
        "synthetic-client-secret",
      );
    },
  );

  it("composes every hosted provider only after runtime, web, OAuth, and GitHub config validate", async () => {
    const telemetry = observability();
    const ready = (component: "artifact-store" | "database" | "queue" | "runner") => ({
      check: vi.fn(async () => ({
        code: `${component.replace("-", "_").toUpperCase()}_READY`,
        status: "ready" as const,
      })),
      component,
    });
    const probes = {
      "artifact-store": ready("artifact-store"),
      database: ready("database"),
      queue: ready("queue"),
      runner: ready("runner"),
    };
    const health = createRuntimeHealthService({
      clock: { now: () => new Date("2026-07-19T20:00:00.000Z") },
      environment: completeHostedEnvironment(),
      hostedProbes: probes,
      ...telemetry,
    });

    await expect(health.readiness()).resolves.toMatchObject({ status: "ready" });
    await expect(health.runner()).resolves.toMatchObject({ status: "ready" });
    expect(probes.database.check).toHaveBeenCalledTimes(1);
    expect(probes["artifact-store"].check).toHaveBeenCalledTimes(1);
    expect(probes.queue.check).toHaveBeenCalledTimes(1);
    expect(probes.runner.check).toHaveBeenCalledTimes(1);
  });
});
