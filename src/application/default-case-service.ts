import { randomUUID } from "node:crypto";

import { getRuntimeConfig, type RuntimeConfig } from "@/config/runtime";
import { ContentAddressedArtifactStore } from "@/infrastructure/artifacts/content-addressed-store";
import { VercelPrivateBlobClient } from "@/infrastructure/artifacts/vercel-private-blob-client";
import { applyPostgresMigrations } from "@/infrastructure/postgres/migrations";
import { createNeonPostgresDatabase } from "@/infrastructure/postgres/neon-database";
import {
  PostgresDurableReproductionRepository,
  PostgresOutbox,
  PostgresUnitOfWork,
} from "@/infrastructure/postgres/repositories";
import { VercelJobQueue } from "@/infrastructure/queue/vercel-job-queue";
import { InMemoryReproductionRepository } from "@/infrastructure/reproduction-repository";

import { CaseService, type CaseOperations } from "./case-service";
import { DurableTrustedCaseService } from "./durable-trusted-case-service";
import type { ReproductionSnapshot } from "./reproduction-contracts";
import type { SampleCaseResult } from "./sample-case";

type HostedRuntimeConfig = Extract<
  RuntimeConfig,
  { mode: "preview" | "production" }
>;

type RuntimeCaseServiceFactories = Readonly<{
  createHosted(config: HostedRuntimeConfig): Promise<CaseOperations>;
  createOffline(): CaseOperations;
}>;

const TRUSTED_TENANT_ID = "tenant_public_trusted_fixture";
const WEB_DEMO_CALLER = "web:trusted-demo";
const WEB_DEMO_KEY = "trusted-home-v2";

class LazyCaseOperations implements CaseOperations {
  private service?: Promise<CaseOperations>;

  constructor(
    private readonly createService: () => Promise<CaseOperations>,
  ) {}

  async startTrustedReproduction(
    ...parameters: Parameters<CaseOperations["startTrustedReproduction"]>
  ) {
    return (await this.resolve()).startTrustedReproduction(...parameters);
  }

  async getReproduction(
    ...parameters: Parameters<CaseOperations["getReproduction"]>
  ) {
    return (await this.resolve()).getReproduction(...parameters);
  }

  async getJob(...parameters: Parameters<CaseOperations["getJob"]>) {
    return (await this.resolve()).getJob(...parameters);
  }

  async exportReproBundle(
    ...parameters: Parameters<CaseOperations["exportReproBundle"]>
  ) {
    return (await this.resolve()).exportReproBundle(...parameters);
  }

  private resolve(): Promise<CaseOperations> {
    this.service ??= this.createService();
    return this.service;
  }
}

function createOfflineCaseService(): CaseOperations {
  return new CaseService({
    clock: { now: () => new Date() },
    identifiers: {
      nextCaseId: () => `case_${randomUUID()}`,
      nextJobId: () => `job_${randomUUID()}`,
    },
    repository: new InMemoryReproductionRepository(),
  });
}

async function createHostedCaseService(
  config: HostedRuntimeConfig,
): Promise<CaseOperations> {
  const database = createNeonPostgresDatabase(config.credentials.databaseUrl);
  await applyPostgresMigrations(database);
  await database.query(
    `INSERT INTO tenants (id, created_at, updated_at)
     VALUES ($1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     ON CONFLICT (id) DO NOTHING`,
    [TRUSTED_TENANT_ID],
  );
  const clock = { now: () => new Date() };
  const repository = new PostgresDurableReproductionRepository(database);
  return new DurableTrustedCaseService({
    artifactStore: new ContentAddressedArtifactStore(
      database,
      new VercelPrivateBlobClient(config.credentials.blob),
      clock,
    ),
    clock,
    identifiers: {
      nextCaseId: () => `case_${randomUUID()}`,
      nextJobId: () => `job_${randomUUID()}`,
      nextWorkerOwnerId: () => `worker_${randomUUID()}`,
    },
    leaseSeconds: config.jobLeaseSeconds,
    outbox: new PostgresOutbox(database),
    outboxPolicy: {
      claimSeconds: config.outboxClaimSeconds,
      maxAttempts: config.maxDeliveryAttempts,
      maxBatchSize: config.outboxBatchSize,
      ownerId: `publisher_${randomUUID()}`,
    },
    queue: new VercelJobQueue({
      region: config.queueRegion,
      retentionSeconds: config.queueRetentionSeconds,
      topic: config.queueTopic,
    }),
    repository,
    retentionDays: config.retentionDays,
    tenantId: TRUSTED_TENANT_ID,
    unitOfWork: new PostgresUnitOfWork(database, {
      "active-jobs": config.maxActiveJobsPerTenant,
    }),
  });
}

const defaultFactories: RuntimeCaseServiceFactories = {
  createHosted: createHostedCaseService,
  createOffline: createOfflineCaseService,
};

export function createCaseOperationsForRuntime(
  config: RuntimeConfig,
  factories: RuntimeCaseServiceFactories = defaultFactories,
): CaseOperations {
  if (config.mode === "preview" || config.mode === "production") {
    const hostedConfig = config;
    return new LazyCaseOperations(() =>
      factories.createHosted(hostedConfig),
    );
  }
  return factories.createOffline();
}

export function createDeferredRuntimeCaseOperations(
  loadConfig: () => RuntimeConfig = getRuntimeConfig,
  factories: RuntimeCaseServiceFactories = defaultFactories,
): CaseOperations {
  return new LazyCaseOperations(async () =>
    createCaseOperationsForRuntime(loadConfig(), factories),
  );
}

const serviceGlobal = globalThis as typeof globalThis & {
  __reproForgeCaseService?: CaseOperations;
};

export const defaultCaseService =
  serviceGlobal.__reproForgeCaseService ??
  createDeferredRuntimeCaseOperations();

if (process.env.NODE_ENV !== "production") {
  serviceGlobal.__reproForgeCaseService = defaultCaseService;
}

export async function getTrustedWebSample(): Promise<SampleCaseResult> {
  const snapshot = await getTrustedWebSnapshot();
  if (!snapshot.result) {
    throw new Error("The trusted web sample did not complete inline");
  }
  return snapshot.result;
}

export async function getTrustedWebSnapshot(): Promise<ReproductionSnapshot> {
  const started = await defaultCaseService.startTrustedReproduction({
    callerId: WEB_DEMO_CALLER,
    idempotencyKey: WEB_DEMO_KEY,
    sampleId: "cli-spaces",
  });
  return started.snapshot;
}
