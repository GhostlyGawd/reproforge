import { getWebSessionState } from "@/auth/auth0-client";
import { createGitHubInstallationCallbackHandler } from "@/github/callback";
import { getDefaultGitHubAuthorizationServices } from "@/github/default-services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function invalidRedirect(request: Request): Response {
  const destination = new URL("/repositories", request.url);
  destination.searchParams.set("github", "invalid");
  return new Response(null, {
    headers: { "Cache-Control": "no-store", Location: destination.toString() },
    status: 303,
  });
}

export async function GET(request: Request): Promise<Response> {
  try {
    const session = await getWebSessionState();
    if (session.status !== "signed_in") return invalidRedirect(request);
    const services = await getDefaultGitHubAuthorizationServices();
    return createGitHubInstallationCallbackHandler({
      actor: () => services.webPrincipals.resolve(session.identity),
      baseUrl: services.config.baseUrl,
      bind: (actor, installation) => services.store.bind(actor, installation),
      states: services.store,
      verifier: services.client,
    })(request);
  } catch {
    return invalidRedirect(request);
  }
}
