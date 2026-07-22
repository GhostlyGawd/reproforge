import "server-only";

import type { RepositoryApiAuthorizer } from "@/application/ports/http-authorization";
import { DeferredRepositoryOperations } from "@/application/repository-catalog-operations";
import { createJwtAccessTokenVerifier } from "@/auth/access-token-verifier";
import { createRepositoryApiAuthorizer } from "@/auth/repository-api-authorizer";
import { getOAuthResourceConfig } from "@/config/oauth";
import { getDefaultGitHubServices } from "@/github/default-services";
import { PostgresPrincipalDirectory } from "@/infrastructure/identity/postgres-principal-directory";

let verifier: ReturnType<typeof createJwtAccessTokenVerifier> | undefined;

export const repositoryOperations = new DeferredRepositoryOperations(async () =>
  (await getDefaultGitHubServices()).repositoryOperations,
);

export const authorizeRepositoryApi: RepositoryApiAuthorizer = async (
  request,
  scopes,
) => {
  try {
    const config = getOAuthResourceConfig();
    const services = await getDefaultGitHubServices();
    verifier ??= createJwtAccessTokenVerifier({ config });
    return createRepositoryApiAuthorizer({
      config,
      directory: new PostgresPrincipalDirectory(services.database),
      verifier,
    })(request, scopes);
  } catch {
    return {
      code: "AUTHORIZATION_UNAVAILABLE",
      message: "ReproForge authorization is temporarily unavailable",
      ok: false,
      status: 503,
    };
  }
};
