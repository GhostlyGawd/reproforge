import { getWebSessionState } from "@/auth/auth0-client";
import { getDefaultGitHubServices } from "@/github/default-services";
import { createGitHubInstallHandler } from "@/github/install-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const session = await getWebSessionState();
    if (session.status !== "signed_in") {
      return createGitHubInstallHandler({
        actor: async () => null,
        appSlug: "reproforge",
        baseUrl: `${new URL(request.url).origin}/`,
        states: {
          create: async () => undefined,
          consume: async () => null,
        },
      })();
    }
    const services = await getDefaultGitHubServices();
    return createGitHubInstallHandler({
      actor: () => services.webPrincipals.resolve(session.identity),
      appSlug: services.config.appSlug,
      baseUrl: services.config.baseUrl,
      states: services.store,
    })();
  } catch {
    return Response.json(
      { error: "github_installation_unavailable" },
      { headers: { "Cache-Control": "no-store" }, status: 503 },
    );
  }
}
