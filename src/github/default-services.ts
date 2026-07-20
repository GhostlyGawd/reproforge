import "server-only";

import type { WebIdentity } from "@/auth/web-session";
import { RepositoryCatalogOperations } from "@/application/repository-catalog-operations";
import type { RepositoryOperations } from "@/application/repository-operations";
import { getGitHubConfig, type GitHubConfig } from "@/config/github";
import { getRuntimeConfig } from "@/config/runtime";
import { GitHubAppClient } from "@/github/app-client";
import { GitHubRepositoryProvider } from "@/github/repository-provider";
import { PostgresGitHubAuthorizationStore } from "@/infrastructure/github/postgres-github-authorization-store";
import { PostgresWebPrincipalSession } from "@/infrastructure/identity/postgres-web-principal-session";
import { applyPostgresMigrations } from "@/infrastructure/postgres/migrations";
import {
  createNeonPostgresDatabase,
  type NeonPostgresDatabase,
} from "@/infrastructure/postgres/neon-database";
import { PostgresAuditSink } from "@/infrastructure/postgres/repositories";

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
  return {
    client,
    config,
    database,
    provider,
    repositoryOperations: new RepositoryCatalogOperations(provider),
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
