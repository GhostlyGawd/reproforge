import { defaultCaseService } from "@/application/default-case-service";
import { DeferredRepositoryOperations } from "@/application/repository-catalog-operations";
import { createJwtAccessTokenVerifier } from "@/auth/access-token-verifier";
import { getOAuthResourceConfig } from "@/config/oauth";
import { getDefaultGitHubServices } from "@/github/default-services";
import { PostgresPrincipalDirectory } from "@/infrastructure/identity/postgres-principal-directory";
import { createReproForgeMcpHttpHandler } from "@/mcp/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

let verifier: ReturnType<typeof createJwtAccessTokenVerifier> | undefined;

const repositoryService = new DeferredRepositoryOperations(async () =>
  (await getDefaultGitHubServices()).repositoryOperations,
);

const handle = createReproForgeMcpHttpHandler({
  authorization: async (request) => {
    try {
      const config = getOAuthResourceConfig();
      const services = await getDefaultGitHubServices();
      verifier ??= createJwtAccessTokenVerifier({ config });
      return {
        authorizationHeader: request.headers.get("authorization"),
        config,
        directory: new PostgresPrincipalDirectory(services.database),
        verifier,
      };
    } catch {
      return undefined;
    }
  },
  repositoryService,
  service: defaultCaseService,
});

export const DELETE = handle;
export const GET = handle;
export const OPTIONS = handle;
export const POST = handle;
export const PUT = handle;
