import "server-only";

import { randomUUID } from "node:crypto";

import type { WebIdentity } from "@/auth/web-session";
import { DurableQueueConsumer } from "@/application/durable-queue-consumer";
import { DurableRepositoryCaseService } from "@/application/durable-repository-case-service";
import { TrustedFixtureDurableWorker } from "@/application/durable-trusted-case-service";
import type { RepositoryOperations } from "@/application/repository-operations";
import { runTrustedSample } from "@/application/sample-case";
import { getGitHubConfig, type GitHubConfig } from "@/config/github";
import { getRuntimeConfig } from "@/config/runtime";
import { IsolatedRepositoryRunner } from "@/execution/isolated-repository-runner";
import { VercelSandboxProvider } from "@/execution/vercel-sandbox";
import { GitHubAppClient } from "@/github/app-client";
import { GitHubRepositoryProvider } from "@/github/repository-provider";
import { ContentAddressedArtifactStore } from "@/infrastructure/artifacts/content-addressed-store";
import { VercelPrivateBlobClient } from "@/infrastructure/artifacts/vercel-private-blob-client";
import { AuditSandboxQuarantineSink } from "@/infrastructure/execution/audit-sandbox-quarantine-sink";
import { PostgresGitHubAuthorizationStore } from "@/infrastructure/github/postgres-github-authorization-store";
import { PostgresWebPrincipalSession } from "@/infrastructure/identity/postgres-web-principal-session";
import { applyPostgresMigrations } from "@/infrastructure/postgres/migrations";
import {
  createNeonPostgresDatabase,
  type NeonPostgresDatabase,
} from "@/infrastructure/postgres/neon-database";
import {
  PostgresAuditSink,
  PostgresDurableReproductionRepository,
  PostgresOutbox,
  PostgresUnitOfWork,
} from "@/infrastructure/postgres/repositories";
import { VercelJobQueue } from "@/infrastructure/queue/vercel-job-queue";

const REPOSITORY_LEASE_SECONDS = 1_200;

export class GitHubRuntimeUnavailableError extends Error {
  readonly code = "GITHUB_RUNTIME_UNAVAILABLE" as const;

  constructor() {
    super("The GitHub authorization runtime is unavailable");
    this.name = "GitHubRuntimeUnavailableError";
  }
}

export type DefaultGitHubServices = {
  client: GitHubAppClient;
  config: GitHubConfig;
  database: NeonPostgresDatabase;
  provider: GitHubRepositoryProvider;
  queueConsumer: Pick<DurableQueueConsumer, "consume">;
  repositoryOperations: RepositoryOperations;
  store: PostgresGitHubAuthorizationStore;
  webPrincipals: PostgresWebPrincipalSession;
};

let services: Promise<DefaultGitHubServices> | undefined;

async function createServices(): Promise<DefaultGitHubServices> {
  const runtime = getRuntimeConfig();
  if (runtime.mode !== "preview" && runtime.mode !== "production") {
    throw new GitHubRuntimeUnavailableError();
  }
  const config = getGitHubConfig();
  const database = createNeonPostgresDatabase(runtime.credentials.databaseUrl);
  await applyPostgresMigrations(database);
  const store = new PostgresGitHubAuthorizationStore(database);
  const client = new GitHubAppClient({
    apiBaseUrl: config.apiBaseUrl,
    appId: config.appId,
    clientId: config.clientId,
    clientSecret: config.credentials.clientSecret,
    privateKey: config.credentials.privateKey,
  });
  const provider = new GitHubRepositoryProvider(store, client, {
    audit: new PostgresAuditSink(database),
  });
  const clock = { now: () => new Date() };
  const audit = new PostgresAuditSink(database);
  const artifactStore = new ContentAddressedArtifactStore(
    database,
    new VercelPrivateBlobClient(runtime.credentials.blob),
    clock,
  );
  const repository = new PostgresDurableReproductionRepository(database);
  const runner = new IsolatedRepositoryRunner({
    clock,
    credentialProvider: provider,
    provider: new VercelSandboxProvider(),
    quarantine: new AuditSandboxQuarantineSink(audit, clock),
  });
  const repositoryRuntime = new DurableRepositoryCaseService({
    artifactStore,
    clock,
    executionMode: "queued",
    identifiers: {
      nextCaseId: () => `case_${randomUUID()}`,
      nextJobId: () => `job_${randomUUID()}`,
      nextWorkerOwnerId: () => `worker_${randomUUID()}`,
    },
    leaseSeconds: Math.max(runtime.jobLeaseSeconds, REPOSITORY_LEASE_SECONDS),
    outbox: new PostgresOutbox(database),
    outboxPolicy: {
      claimSeconds: runtime.outboxClaimSeconds,
      maxAttempts: runtime.maxDeliveryAttempts,
      maxBatchSize: runtime.outboxBatchSize,
      ownerId: `publisher_${randomUUID()}`,
    },
    queue: new VercelJobQueue({
      region: runtime.queueRegion,
      retentionSeconds: runtime.queueRetentionSeconds,
      topic: runtime.queueTopic,
    }),
    repository,
    retentionDays: runtime.retentionDays,
    runner,
    source: provider,
    unitOfWork: new PostgresUnitOfWork(database, {
      "active-jobs": runtime.maxActiveJobsPerTenant,
    }),
  });
  const trustedWorker = new TrustedFixtureDurableWorker(
    artifactStore,
    clock,
    runTrustedSample,
    runtime.retentionDays,
  );
  const queueConsumer = new DurableQueueConsumer({
    clock,
    leaseSeconds: Math.max(runtime.jobLeaseSeconds, REPOSITORY_LEASE_SECONDS),
    repository,
    worker: {
      execute: (input) =>
        input.record.repositoryRequest ||
        input.record.snapshot.repositorySource
          ? repositoryRuntime.executeClaimedWork(input)
          : trustedWorker.execute(input),
    },
  });
  return {
    client,
    config,
    database,
    provider,
    queueConsumer,
    repositoryOperations: repositoryRuntime,
    store,
    webPrincipals: new PostgresWebPrincipalSession(database),
  };
}

export function getDefaultGitHubServices(): Promise<DefaultGitHubServices> {
  services ??= createServices();
  return services;
}

export async function listWebRepositories(identity: WebIdentity) {
  const resolved = await getDefaultGitHubServices();
  const actor = await resolved.webPrincipals.resolve(identity);
  return resolved.store.listRepositories({ limit: 100, tenantId: actor.tenantId });
}
