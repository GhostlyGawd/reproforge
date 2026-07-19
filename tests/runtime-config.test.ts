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
          "BLOB_READ_WRITE_TOKEN",
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

  it("parses bounded policy values without exposing provider credentials", () => {
    const parsed = parseRuntimeConfig({
      ...productionEnvironment,
      REPROFORGE_JOB_LEASE_SECONDS: "120",
      REPROFORGE_MAX_ACTIVE_JOBS_PER_TENANT: "3",
      REPROFORGE_RETENTION_DAYS: "14",
    });

    expect(parsed).toMatchObject({
      baseUrl: "https://reproforge.example/",
      jobLeaseSeconds: 120,
      maxActiveJobsPerTenant: 3,
      providers: {
        artifactStore: "vercel-blob",
        database: "neon",
        queue: "vercel",
      },
      retentionDays: 14,
    });
    const summary = JSON.stringify(summarizeRuntimeConfig(parsed));
    expect(summary).not.toContain(productionEnvironment.DATABASE_URL);
    expect(summary).not.toContain(productionEnvironment.BLOB_READ_WRITE_TOKEN);
    expect(summary).toContain('"database":"neon"');
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
