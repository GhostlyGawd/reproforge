import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { AuthorizedPrincipal } from "@/application/authorization";
import { RepositoryStartUnavailableError } from "@/application/case-service";
import { DurableRepositoryCaseService } from "@/application/durable-repository-case-service";
import type { QueueMessage } from "@/application/ports/production";
import { runTrustedSample } from "@/application/sample-case";
import { repositoryProofResultSchema } from "@/execution/repository-proof";
import type { IsolatedRepositoryRunner } from "@/execution/isolated-repository-runner";
import { ContentAddressedArtifactStore } from "@/infrastructure/artifacts/content-addressed-store";
import { applyPostgresMigrations } from "@/infrastructure/postgres/migrations";
import {
  PostgresDurableReproductionRepository,
  PostgresOutbox,
  PostgresUnitOfWork,
} from "@/infrastructure/postgres/repositories";

import { MemoryPrivateBlobClient } from "./helpers/memory-private-blob-client";
import { pgliteMigrationClient } from "./helpers/pglite-migration-client";
import { pglitePostgresDatabase } from "./helpers/pglite-postgres-database";

vi.setConfig({ hookTimeout: 30_000, testTimeout: 30_000 });

const tenantId = "tenant_repository_service";
const principal: AuthorizedPrincipal = {
  callerId: "principal_repository_service",
  expiresAt: 4_102_444_800,
  issuer: "https://identity.example.com/",
  principalId: "principal_repository_service",
  scopes: [
    "reproforge:bundles:read",
    "reproforge:cases:read",
    "reproforge:cases:write",
    "reproforge:repositories:read",
  ],
  subject: "auth0|repository-service",
  tenantId,
};
const source = {
  commitSha: "a".repeat(40),
  defaultBranch: "main",
  fullName: "acme/repository",
  private: true,
  provider: "github" as const,
  repositoryId: "repo_42",
};
const request = {
  budget: { maxToolCalls: 6, requiredRuns: 3 },
  idempotencyKey: "repository-service-start",
  source: {
    commitSha: source.commitSha,
    executionProfile: {
      controlScript: "test:control",
      ecosystem: "node" as const,
      lockfile: "package-lock.json" as const,
      nodeVersion: "24" as const,
      packageManager: "npm" as const,
      reproductionScript: "test:repro",
    },
    failureOracle: {
      id: "oracle-repository-service",
      root: { expected: 1, type: "exit_code" as const },
      version: 1,
    },
    issueEvidence: { number: 42, title: "Synthetic repository failure" },
    kind: "github" as const,
    repositoryId: source.repositoryId,
  },
};

let database: PGlite;
let service: DurableRepositoryCaseService;
let queuedService: DurableRepositoryCaseService;
let cancellableService: DurableRepositoryCaseService;
let degradedService: DurableRepositoryCaseService;
let queuedMessages: QueueMessage[];
let runnerCalls = 0;
let runnerExecute: IsolatedRepositoryRunner["execute"];
let cancellationRunnerStarted: Promise<void>;
let cancellationAbortObserved = false;

beforeAll(async () => {
  database = new PGlite();
  await applyPostgresMigrations(pgliteMigrationClient(database));
  const postgres = pglitePostgresDatabase(database);
  await database.query("INSERT INTO tenants (id) VALUES ($1)", [tenantId]);
  const clock = { now: () => new Date("2026-07-21T16:00:00.000Z") };
  const artifacts = new ContentAddressedArtifactStore(
    postgres,
    new MemoryPrivateBlobClient(),
    clock,
  );
  queuedMessages = [];
  let id = 0;
  runnerExecute = vi.fn(async (input) => {
    runnerCalls += 1;
    const sample = await runTrustedSample({
      caseId: input.case.id,
      startedAt: new Date(input.case.createdAt),
    });
    return repositoryProofResultSchema.parse({
      ...sample,
      kind: "repository",
      provenance: {
        cleanupStatus: "clean",
        dependency: {
          dependencyCount: 12,
          lockfileSha256: "d".repeat(64),
          lockfileVersion: 3,
          packageJsonSha256: "e".repeat(64),
          policyVersion: "node-lock-v1",
        },
        environment: {
          archiveSha256: "b".repeat(64),
          dependencyPolicyVersion: "node-lock-v1",
          environmentHash: "f".repeat(64),
          executionPolicyVersion: "node-npm-v1",
          lockfileSha256: "d".repeat(64),
          manifestSha256: "c".repeat(64),
          networkPolicy: "deny-all",
          nodeVersion: "24.8.0",
          npmVersion: "11.4.2",
          packageJsonSha256: "e".repeat(64),
          provider: "vercel-sandbox",
          runtime: "node24",
          schemaVersion: "1.0",
          sourceCommitSha: input.source.commitSha,
          sourcePolicyVersion: "source-archive-v1",
          vcpus: 2,
        },
        limitsPolicyVersion: "sandbox-limits-v1",
        source: {
          acquiredAt: "2026-07-21T16:00:00.000Z",
          archiveBytes: 4_096,
          archiveSha256: "b".repeat(64),
          commitSha: input.source.commitSha,
          extractedBytes: 8_192,
          fileCount: 8,
          manifestSha256: "c".repeat(64),
          policyVersion: "source-archive-v1",
          provider: "github",
          repositoryId: input.source.repositoryId,
          schemaVersion: "1.0",
        },
      },
    });
  });
  const outbox = new PostgresOutbox(postgres);
  const repository = new PostgresDurableReproductionRepository(postgres);
  const queue = {
    send: async (message: QueueMessage) => {
      queuedMessages.push(message);
      return { messageId: `queue_repository_${queuedMessages.length}` };
    },
  };
  const unitOfWork = new PostgresUnitOfWork(postgres, { "active-jobs": 2 });
  const common = {
    artifactStore: artifacts,
    clock,
    leaseSeconds: 90,
    outbox,
    outboxPolicy: {
      claimSeconds: 30,
      maxAttempts: 5,
      maxBatchSize: 25,
      ownerId: "publisher_repository_service",
    },
    queue,
    repository,
    retentionDays: 30,
    runner: { execute: runnerExecute },
    source: {
      listAuthorizedRepositories: async () => ({
        nextCursor: null,
        repositories: [source],
        tenantId,
      }),
      resolveRevision: async () => source,
    },
    unitOfWork,
  } as const;
  service = new DurableRepositoryCaseService({
    ...common,
    identifiers: {
      nextCaseId: () => `case_repository_${++id}`,
      nextJobId: () => `job_repository_${id}`,
      nextWorkerOwnerId: () => `worker_repository_${id}`,
    },
  });
  queuedService = new DurableRepositoryCaseService({
    ...common,
    executionMode: "queued",
    identifiers: {
      nextCaseId: () => `case_repository_queued_${++id}`,
      nextJobId: () => `job_repository_queued_${id}`,
      nextWorkerOwnerId: () => `worker_repository_queued_${id}`,
    },
  });
  let markCancellationRunnerStarted!: () => void;
  cancellationRunnerStarted = new Promise((resolve) => {
    markCancellationRunnerStarted = resolve;
  });
  cancellableService = new DurableRepositoryCaseService({
    ...common,
    cancellationPollMs: 10,
    executionMode: "queued",
    identifiers: {
      nextCaseId: () => `case_repository_cancel_${++id}`,
      nextJobId: () => `job_repository_cancel_${id}`,
      nextWorkerOwnerId: () => `worker_repository_cancel_${id}`,
    },
    runner: {
      execute: async (input) => {
        markCancellationRunnerStarted();
        return new Promise((_, reject) => {
          const guard = setTimeout(
            () => reject(new Error("cancellation signal was not streamed")),
            250,
          );
          input.signal?.addEventListener(
            "abort",
            () => {
              cancellationAbortObserved = true;
              clearTimeout(guard);
              reject(new Error("synthetic cancelled runner"));
            },
            { once: true },
          );
        });
      },
    },
  });
  degradedService = new DurableRepositoryCaseService({
    ...common,
    identifiers: {
      nextCaseId: () => `case_repository_degraded_${++id}`,
      nextJobId: () => `job_repository_degraded_${id}`,
      nextWorkerOwnerId: () => `worker_repository_degraded_${id}`,
    },
    startAdmission: {
      assertAllowed: async () => {
        throw new RepositoryStartUnavailableError();
      },
    },
  });
});

afterAll(async () => {
  await database.close();
});

describe("durable repository case service", () => {
  it("runs an authorized immutable request through proof, artifact, and terminal transaction", async () => {
    const first = await service.startRepositoryReproduction(principal, request);
    const retry = await service.startRepositoryReproduction(principal, request);

    expect(first.reused).toBe(false);
    expect(first.snapshot).toMatchObject({
      case: { state: "VERIFIED" },
      job: { state: "SUCCEEDED" },
      repositorySource: {
        commitSha: source.commitSha,
        repositoryId: source.repositoryId,
      },
      result: { kind: "repository", summary: { status: "VERIFIED" } },
    });
    expect(retry).toEqual({ reused: true, snapshot: first.snapshot });
    expect(runnerCalls).toBe(1);

    await expect(
      service.getReproduction(principal, {
        caseId: first.snapshot.case.id,
      }),
    ).resolves.toEqual(first.snapshot);
    const exported = await service.exportReproBundle(principal, {
      caseId: first.snapshot.case.id,
    });
    expect(exported.bundle.bundleHash).toBe(
      first.snapshot.result?.bundle?.bundleHash,
    );
  });

  it("lists only the caller tenant's authorized repository catalog", async () => {
    await expect(
      service.listAuthorizedRepositories(principal, { limit: 50 }),
    ).resolves.toMatchObject({
      repositories: [{ fullName: source.fullName }],
      tenantId,
    });
  });

  it("returns queued work before the private consumer executes the sandbox", async () => {
    const callsBeforeStart = runnerCalls;
    const started = await queuedService.startRepositoryReproduction(principal, {
      ...request,
      idempotencyKey: "repository-service-queued-start",
    });

    expect(started).toMatchObject({
      reused: false,
      snapshot: {
        case: { state: "DRAFT" },
        job: { state: "QUEUED" },
        result: null,
      },
    });
    expect(runnerCalls).toBe(callsBeforeStart);
    const message = queuedMessages.at(-1);
    expect(message).toMatchObject({
      caseId: started.snapshot.case.id,
      jobId: started.snapshot.job.id,
      kind: "reproduction.requested",
      tenantId,
    });

    await expect(
      queuedService.consumeQueueMessage(message!, "worker_queue_callback"),
    ).resolves.toMatchObject({ outcome: "completed" });
    await expect(
      queuedService.getReproduction(principal, {
        caseId: started.snapshot.case.id,
      }),
    ).resolves.toMatchObject({
      case: { state: "VERIFIED" },
      job: { state: "SUCCEEDED" },
      result: { kind: "repository", summary: { status: "VERIFIED" } },
    });
    expect(runnerCalls).toBe(callsBeforeStart + 1);
  });

  it("streams a durable cancellation request into active repository work", async () => {
    const started = await cancellableService.startRepositoryReproduction(
      principal,
      {
        ...request,
        idempotencyKey: "repository-service-cancel-start",
      },
    );
    const message = queuedMessages.at(-1)!;
    const consuming = cancellableService.consumeQueueMessage(
      message,
      "worker_cancellation_callback",
    );
    await cancellationRunnerStarted;

    await expect(
      cancellableService.cancelReproduction(principal, {
        jobId: started.snapshot.job.id,
      }),
    ).resolves.toMatchObject({ disposition: "requested" });
    await expect(consuming).resolves.toMatchObject({ outcome: "cancelled" });
    expect(cancellationAbortObserved).toBe(true);
    await expect(
      cancellableService.getReproduction(principal, {
        caseId: started.snapshot.case.id,
      }),
    ).resolves.toMatchObject({
      case: { state: "CANCELLED" },
      job: { state: "CANCELLED" },
    });
  });

  it("blocks a new start during runner degradation while completed cases and retries remain readable", async () => {
    const completedRequest = {
      ...request,
      idempotencyKey: "repository-service-before-degradation",
    };
    const completed = await service.startRepositoryReproduction(
      principal,
      completedRequest,
    );

    await expect(
      degradedService.startRepositoryReproduction(principal, completedRequest),
    ).resolves.toEqual({ reused: true, snapshot: completed.snapshot });
    await expect(
      degradedService.getReproduction(principal, {
        caseId: completed.snapshot.case.id,
      }),
    ).resolves.toEqual(completed.snapshot);
    await expect(
      degradedService.startRepositoryReproduction(principal, {
        ...request,
        idempotencyKey: "repository-service-during-degradation",
      }),
    ).rejects.toMatchObject({
      code: "RUNNER_UNAVAILABLE",
      retryable: true,
    });
  });
});
