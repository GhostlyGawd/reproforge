import "server-only";

import { randomUUID } from "node:crypto";

import type { WebIdentity } from "@/auth/web-session";
import { AccountDataService } from "@/application/account-data-service";
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
import { createGitHubServiceRegistry } from "@/github/service-registry";
import { ContentAddressedArtifactStore } from "@/infrastructure/artifacts/content-addressed-store";
import { VercelPrivateBlobClient } from "@/infrastructure/artifacts/vercel-private-blob-client";
import { JsonTenantBackupLogger } from "@/infrastructure/backup/observability";
import { PostgresTenantBackupService } from "@/infrastructure/backup/postgres-tenant-backup";
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
import { PostgresTenantDataRetention } from "@/infrastructure/retention/postgres-tenant-data-retention";
import { PostgresAccountExportQuota } from "@/infrastructure/operations/postgres-account-export-quota";
import {
  CompositeRepositoryStartAdmission,
  FeatureFlagRepositoryStartAdmission,
} from "@/infrastructure/operations/feature-start-admission";
import { createSandboxRunnerHealthProbe } from "@/infrastructure/operations/runtime-health";
import { SandboxRunnerStartAdmission } from "@/infrastructure/operations/repository-start-admission";

const REPOSITORY_LEASE_SECONDS = 1_200;

export class GitHubRuntimeUnavailableError extends Error {
  readonly code = "GITHUB_RUNTIME_UNAVAILABLE" as const;

  constructor() {
    super("The GitHub authorization runtime is unavailable");
    this.name = "GitHubRuntimeUnavailableError";
  }
}

export type DefaultGitHubAuthorizationServices = {
  client: GitHubAppClient;
  config: GitHubConfig;
  database: NeonPostgresDatabase;
  store: PostgresGitHubAuthorizationStore;
  webPrincipals: PostgresWebPrincipalSession;
};

export type DefaultGitHubServices = DefaultGitHubAuthorizationServices & {
  accountData: AccountDataService;
  provider: GitHubRepositoryProvider;
  queueConsumer: Pick<DurableQueueConsumer, "consume">;
  repositoryOperations: RepositoryOperations;
};

async function createAuthorizationServices(): Promise<DefaultGitHubAuthorizationServices> {
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
  return {
    client,
    config,
    database,
    store,
    webPrincipals: new PostgresWebPrincipalSession(database),
  };
}

async function createServices(
  authorization: DefaultGitHubAuthorizationServices,
): Promise<DefaultGitHubServices> {
  const runtime = getRuntimeConfig();
  if (runtime.mode !== "preview" && runtime.mode !== "production") {
    throw new GitHubRuntimeUnavailableError();
  }
  const { client, config, database, store, webPrincipals } = authorization;
  const provider = new GitHubRepositoryProvider(store, client, {
    audit: new PostgresAuditSink(database),
  });
  const clock = { now: () => new Date() };
  const audit = new PostgresAuditSink(database);
  const blobClient = new VercelPrivateBlobClient(runtime.credentials.blob);
  const artifactStore = new ContentAddressedArtifactStore(
    database,
    blobClient,
    clock,
  );
  const accountData = new AccountDataService({
    audit,
    backup: new PostgresTenantBackupService(
      database,
      blobClient,
      clock,
      new JsonTenantBackupLogger(),
    ),
    clock,
    exportQuota: new PostgresAccountExportQuota(database),
    retention: new PostgresTenantDataRetention(database, blobClient),
  });
  const repository = new PostgresDurableReproductionRepository(database);
  const sandboxProvider = new VercelSandboxProvider();
  const runnerProbe = createSandboxRunnerHealthProbe({
    provider: sandboxProvider,
  });
  const runner = new IsolatedRepositoryRunner({
    clock,
    credentialProvider: provider,
    provider: sandboxProvider,
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
    startAdmission: new CompositeRepositoryStartAdmission([
      new FeatureFlagRepositoryStartAdmission({ audit, flags: runtime }),
      new SandboxRunnerStartAdmission({ audit, probe: runnerProbe }),
    ]),
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
    accountData,
    client,
    config,
    database,
    provider,
    queueConsumer,
    repositoryOperations: repositoryRuntime,
    store,
    webPrincipals,
  };
}

const defaultGitHubServices = createGitHubServiceRegistry({
  createAuthorization: createAuthorizationServices,
  createRuntime: createServices,
});

export function getDefaultGitHubAuthorizationServices(): Promise<DefaultGitHubAuthorizationServices> {
  return defaultGitHubServices.getAuthorizationServices();
}

export function getDefaultGitHubServices(): Promise<DefaultGitHubServices> {
  return defaultGitHubServices.getRuntimeServices();
}

export async function listWebRepositories(identity: WebIdentity) {
  const resolved = await getDefaultGitHubAuthorizationServices();
  const actor = await resolved.webPrincipals.resolve(identity);
  return resolved.store.listRepositories({ limit: 100, tenantId: actor.tenantId });
}

export async function getWebRepositoryCase(
  identity: WebIdentity,
  caseId: string,
) {
  const resolved = await getDefaultGitHubServices();
  const actor = await resolved.webPrincipals.resolve(identity);
  return resolved.repositoryOperations.getReproduction(
    {
      callerId: actor.principalId,
      principalId: actor.principalId,
      tenantId: actor.tenantId,
    },
    { caseId },
  );
}

export async function resolveWebRepositoryPrincipal(identity: WebIdentity) {
  const resolved = await getDefaultGitHubAuthorizationServices();
  const actor = await resolved.webPrincipals.resolve(identity);
  return {
    callerId: actor.principalId,
    principalId: actor.principalId,
    tenantId: actor.tenantId,
  };
}
