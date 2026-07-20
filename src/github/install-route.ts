import {
  createGitHubInstallationAuthorization,
  type GitHubInstallationActor,
  type GitHubInstallationStateStore,
} from "@/github/installation-state";

type InstallDependencies = {
  actor(): Promise<GitHubInstallationActor | null>;
  appSlug: string;
  baseUrl: string;
  clock?: { now(): Date };
  randomBytes?: () => Uint8Array;
  states: GitHubInstallationStateStore;
};

function redirect(location: string): Response {
  return new Response(null, {
    headers: { "Cache-Control": "no-store", Location: location },
    status: 303,
  });
}

export function createGitHubInstallHandler(
  dependencies: InstallDependencies,
): () => Promise<Response> {
  return async function GET(): Promise<Response> {
    try {
      const actor = await dependencies.actor();
      if (!actor) {
        const login = new URL("auth/login", dependencies.baseUrl);
        login.searchParams.set("returnTo", "/repositories");
        return redirect(login.toString());
      }
      const authorization = await createGitHubInstallationAuthorization({
        actor,
        appSlug: dependencies.appSlug,
        clock: dependencies.clock,
        randomBytes: dependencies.randomBytes,
        states: dependencies.states,
      });
      return redirect(authorization.url);
    } catch {
      return Response.json(
        { error: "github_installation_unavailable" },
        { headers: { "Cache-Control": "no-store" }, status: 503 },
      );
    }
  };
}
