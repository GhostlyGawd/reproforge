import { spawnSync } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import { CaseService, type CaseOperations } from "@/application/case-service";
import {
  createCaseOperationsForRuntime,
  createDeferredRuntimeCaseOperations,
} from "@/application/default-case-service";
import { parseRuntimeConfig } from "@/config/runtime";
import { InMemoryReproductionRepository } from "@/infrastructure/reproduction-repository";

function memoryService(prefix: string): CaseService {
  return new CaseService({
    clock: { now: () => new Date("2026-07-20T20:00:00.000Z") },
    identifiers: {
      nextCaseId: () => `case_${prefix}`,
      nextJobId: () => `job_${prefix}`,
    },
    repository: new InMemoryReproductionRepository(),
  });
}

describe("default case-service runtime composition", () => {
  it("imports during a hosted Next build without resolving runtime credentials", () => {
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_ENV: "production",
      REPROFORGE_RUNTIME_MODE: "preview",
      VERCEL_ENV: "preview",
    };
    for (const name of [
      "BLOB_READ_WRITE_TOKEN",
      "BLOB_STORE_ID",
      "DATABASE_URL",
      "REPROFORGE_BASE_URL",
      "VERCEL_OIDC_TOKEN",
    ]) {
      delete environment[name];
    }

    const imported = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        "await import('./src/application/default-case-service.ts'); process.stdout.write('imported');",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: environment,
      },
    );

    expect(imported.stderr).toBe("");
    expect(imported.status).toBe(0);
    expect(imported.stdout).toBe("imported");
  });

  it("memoizes request-time configuration failure without an offline fallback", async () => {
    const failure = new Error("synthetic incomplete hosted configuration");
    const loadConfig = vi.fn(() => {
      throw failure;
    });
    const createOffline = vi.fn(() => memoryService("forbidden_fallback"));
    const createHosted = vi.fn<() => Promise<CaseOperations>>();
    const service = createDeferredRuntimeCaseOperations(loadConfig, {
      createHosted,
      createOffline,
    });

    expect(loadConfig).not.toHaveBeenCalled();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(
        service.getReproduction({
          callerId: "caller_hosted_config_failure",
          caseId: "case_missing",
        }),
      ).rejects.toBe(failure);
    }

    expect(loadConfig).toHaveBeenCalledTimes(1);
    expect(createHosted).not.toHaveBeenCalled();
    expect(createOffline).not.toHaveBeenCalled();
  });

  it("uses the keyless in-memory slice for an explicit offline runtime", async () => {
    const offline = memoryService("offline");
    const createOffline = vi.fn(() => offline);
    const createHosted = vi.fn<() => Promise<CaseOperations>>();
    const service = createCaseOperationsForRuntime(
      parseRuntimeConfig({ REPROFORGE_RUNTIME_MODE: "offline" }),
      { createHosted, createOffline },
    );

    const started = await service.startTrustedReproduction({
      callerId: "caller_offline",
      idempotencyKey: "key_offline",
      sampleId: "cli-spaces",
    });

    expect(started.snapshot.case.id).toBe("case_offline");
    expect(started.snapshot.result?.summary.status).toBe("VERIFIED");
    expect(createOffline).toHaveBeenCalledTimes(1);
    expect(createHosted).not.toHaveBeenCalled();
  });

  it("lazily creates one hosted durable service and delegates every surface to it", async () => {
    const hosted = memoryService("hosted_delegate");
    const createOffline = vi.fn(() => memoryService("forbidden_fallback"));
    const createHosted = vi.fn(async () => hosted);
    const config = parseRuntimeConfig({
      BLOB_READ_WRITE_TOKEN: "synthetic-blob-token",
      DATABASE_URL: "postgresql://synthetic:credential@example.test/reproforge",
      REPROFORGE_BASE_URL: "https://reproforge.example.test",
      REPROFORGE_RUNTIME_MODE: "production",
    });
    const service = createCaseOperationsForRuntime(config, {
      createHosted,
      createOffline,
    });

    expect(createHosted).not.toHaveBeenCalled();
    const started = await service.startTrustedReproduction({
      callerId: "caller_hosted",
      idempotencyKey: "key_hosted",
      sampleId: "cli-spaces",
    });
    const [snapshot, job, bundle] = await Promise.all([
      service.getReproduction({
        callerId: "caller_hosted",
        caseId: started.snapshot.case.id,
      }),
      service.getJob({
        callerId: "caller_hosted",
        jobId: started.snapshot.job.id,
      }),
      service.exportReproBundle({
        callerId: "caller_hosted",
        caseId: started.snapshot.case.id,
      }),
    ]);

    expect(createHosted).toHaveBeenCalledTimes(1);
    expect(createOffline).not.toHaveBeenCalled();
    expect(snapshot.case.id).toBe(started.snapshot.case.id);
    expect(job.job.id).toBe(started.snapshot.job.id);
    expect(bundle.bundle.bundleHash).toBe(
      started.snapshot.result?.bundle?.bundleHash,
    );
  });

  it("never falls back to process-local state when hosted initialization fails", async () => {
    const failure = new Error("synthetic hosted initialization failure");
    const createOffline = vi.fn(() => memoryService("forbidden_fallback"));
    const createHosted = vi.fn(async () => Promise.reject(failure));
    const config = parseRuntimeConfig({
      BLOB_READ_WRITE_TOKEN: "synthetic-blob-token",
      DATABASE_URL: "postgresql://synthetic:credential@example.test/reproforge",
      REPROFORGE_BASE_URL: "https://reproforge.example.test",
      REPROFORGE_RUNTIME_MODE: "production",
    });
    const service = createCaseOperationsForRuntime(config, {
      createHosted,
      createOffline,
    });

    await expect(
      service.getReproduction({
        callerId: "caller_hosted_failure",
        caseId: "case_missing",
      }),
    ).rejects.toBe(failure);
    expect(createHosted).toHaveBeenCalledTimes(1);
    expect(createOffline).not.toHaveBeenCalled();
  });
});
