import { describe, expect, it } from "vitest";

import {
  RuntimeConfigurationError,
  createRuntimeConfigLoader,
  parseRuntimeConfig,
  summarizeRuntimeConfig,
} from "@/config/runtime";

const productionEnvironment = {
  BLOB_READ_WRITE_TOKEN: "synthetic-blob-token",
  DATABASE_URL: "postgresql://reproforge.invalid/reproforge",
  REPROFORGE_BASE_URL: "https://reproforge.example",
  REPROFORGE_RUNTIME_MODE: "production",
  VERCEL_ENV: "production",
};

describe("runtime configuration", () => {
  it("defaults an unconfigured local process to the offline adapters", () => {
    expect(parseRuntimeConfig({})).toMatchObject({
      disablePrivateRepositories: false,
      disableRepositoryStarts: false,
      disabledExecutionProfiles: [],
      mode: "offline",
      providers: {
        artifactStore: "memory",
        database: "memory",
        queue: "inline",
      },
    });
  });

  it("distinguishes test, preview, and production modes", () => {
    expect(parseRuntimeConfig({ NODE_ENV: "test" }).mode).toBe("test");
    expect(
      parseRuntimeConfig({
        ...productionEnvironment,
        REPROFORGE_RUNTIME_MODE: "preview",
        VERCEL_ENV: "preview",
      }).mode,
    ).toBe("preview");
    expect(parseRuntimeConfig(productionEnvironment).mode).toBe("production");
  });

  it("fails closed instead of falling back when hosted configuration is partial", () => {
    expect(() =>
      parseRuntimeConfig({
        DATABASE_URL: productionEnvironment.DATABASE_URL,
        REPROFORGE_RUNTIME_MODE: "production",
      }),
    ).toThrowError(RuntimeConfigurationError);

    try {
      parseRuntimeConfig({
        DATABASE_URL: productionEnvironment.DATABASE_URL,
        REPROFORGE_RUNTIME_MODE: "production",
      });
    } catch (error) {
      expect(error).toMatchObject({
        code: "INVALID_RUNTIME_CONFIGURATION",
        issues: expect.arrayContaining([
          "BLOB_AUTHENTICATION",
          "REPROFORGE_BASE_URL",
        ]),
      });
      expect(String(error)).not.toContain(productionEnvironment.DATABASE_URL);
    }
  });

  it("requires HTTPS and rejects unknown ReproForge variables in hosted modes", () => {
    expect(() =>
      parseRuntimeConfig({
        ...productionEnvironment,
        REPROFORGE_BASE_URL: "http://reproforge.example",
      }),
    ).toThrowError(/REPROFORGE_BASE_URL/);
    expect(() =>
      parseRuntimeConfig({
        ...productionEnvironment,
        REPROFORGE_DATABSAE: "typo",
      }),
    ).toThrowError(/REPROFORGE_DATABSAE/);
  });

  it("allows ReproForge variables owned by the OAuth configuration boundary", () => {
    expect(
      parseRuntimeConfig({
        ...productionEnvironment,
        REPROFORGE_OAUTH_TENANT_CLAIM: "https://reproforge.dev/tenant_id",
      }).mode,
    ).toBe("production");
  });

  it("parses bounded policy values without exposing provider credentials", () => {
    const parsed = parseRuntimeConfig({
      ...productionEnvironment,
      REPROFORGE_JOB_LEASE_SECONDS: "120",
      REPROFORGE_MAX_ACTIVE_JOBS_PER_TENANT: "3",
      REPROFORGE_MAX_DELIVERY_ATTEMPTS: "7",
      REPROFORGE_OUTBOX_BATCH_SIZE: "50",
      REPROFORGE_OUTBOX_CLAIM_SECONDS: "45",
      REPROFORGE_QUEUE_REGION: "sfo1",
      REPROFORGE_QUEUE_RETENTION_SECONDS: "86400",
      REPROFORGE_QUEUE_TOPIC: "reproforge-preview-v1",
      REPROFORGE_RETENTION_DAYS: "14",
      REPROFORGE_DISABLE_PRIVATE_REPOSITORIES: "true",
      REPROFORGE_DISABLE_REPOSITORY_STARTS: "false",
      REPROFORGE_DISABLED_EXECUTION_PROFILES: "node24,node22,node24",
    });

    expect(parsed).toMatchObject({
      baseUrl: "https://reproforge.example/",
      disablePrivateRepositories: true,
      disableRepositoryStarts: false,
      disabledExecutionProfiles: ["node22", "node24"],
      jobLeaseSeconds: 120,
      maxActiveJobsPerTenant: 3,
      maxDeliveryAttempts: 7,
      outboxBatchSize: 50,
      outboxClaimSeconds: 45,
      providers: {
        artifactStore: "vercel-blob",
        database: "neon",
        queue: "vercel",
      },
      queueRegion: "sfo1",
      queueRetentionSeconds: 86_400,
      queueTopic: "reproforge-preview-v1",
      retentionDays: 14,
    });
    const summary = JSON.stringify(summarizeRuntimeConfig(parsed));
    expect(summary).not.toContain(productionEnvironment.DATABASE_URL);
    expect(summary).not.toContain(productionEnvironment.BLOB_READ_WRITE_TOKEN);
    expect(summary).toContain('"database":"neon"');
    expect(summary).toContain('"disablePrivateRepositories":true');
  });

  it.each([
    ["REPROFORGE_DISABLE_REPOSITORY_STARTS", "yes"],
    ["REPROFORGE_DISABLE_PRIVATE_REPOSITORIES", "1"],
    ["REPROFORGE_DISABLED_EXECUTION_PROFILES", "node20"],
    ["REPROFORGE_DISABLED_EXECUTION_PROFILES", "node22,private"],
  ])("fails closed for invalid feature policy %s", (name, value) => {
    expect(() =>
      parseRuntimeConfig({
        ...productionEnvironment,
        [name]: value,
      }),
    ).toThrowError(new RegExp(name));
  });

  it("prefers short-lived Vercel OIDC credentials for private Blob", () => {
    const parsed = parseRuntimeConfig({
      BLOB_STORE_ID: "store_reproforge",
      DATABASE_URL: productionEnvironment.DATABASE_URL,
      REPROFORGE_BASE_URL: productionEnvironment.REPROFORGE_BASE_URL,
      REPROFORGE_RUNTIME_MODE: "production",
      VERCEL_OIDC_TOKEN: "synthetic-short-lived-oidc-token",
    });

    expect(parsed).toMatchObject({
      credentials: {
        blob: {
          method: "oidc",
          storeId: "store_reproforge",
        },
      },
    });
    expect(JSON.stringify(summarizeRuntimeConfig(parsed))).not.toContain(
      "synthetic-short-lived-oidc-token",
    );
  });

  it("fails closed for a partial Blob OIDC pair", () => {
    expect(() =>
      parseRuntimeConfig({
        BLOB_STORE_ID: "store_reproforge",
        DATABASE_URL: productionEnvironment.DATABASE_URL,
        REPROFORGE_BASE_URL: productionEnvironment.REPROFORGE_BASE_URL,
        REPROFORGE_RUNTIME_MODE: "production",
      }),
    ).toThrowError(/BLOB_AUTHENTICATION/);
  });

  it("does not read or validate the environment until the lazy loader is called", () => {
    let reads = 0;
    const loader = createRuntimeConfigLoader(() => {
      reads += 1;
      return { REPROFORGE_RUNTIME_MODE: "production" };
    });

    expect(reads).toBe(0);
    expect(() => loader()).toThrowError(RuntimeConfigurationError);
    expect(reads).toBe(1);
    expect(() => loader()).toThrowError(RuntimeConfigurationError);
    expect(reads).toBe(1);
  });
});
