import { getWebSessionState } from "@/auth/auth0-client";
import {
  getDefaultGitHubServices,
  resolveWebRepositoryPrincipal,
} from "@/github/default-services";
import { createWebRepositoryStartHandler } from "@/github/repository-start-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    const session = await getWebSessionState();
    const services = await getDefaultGitHubServices();
    return createWebRepositoryStartHandler({
      actor: async () =>
        session.status === "signed_in"
          ? resolveWebRepositoryPrincipal(session.identity)
          : null,
      baseUrl: services.config.baseUrl,
      operations: services.repositoryOperations,
    })(request);
  } catch {
    return Response.json(
      { error: "repository_start_unavailable" },
      { headers: { "Cache-Control": "no-store" }, status: 503 },
    );
  }
}
