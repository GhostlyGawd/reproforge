import { z } from "zod";

import {
  githubInstallationStateHash,
  type GitHubInstallationActor,
  type GitHubInstallationStateStore,
} from "@/github/installation-state";

const callbackSchema = z
  .object({
    code: z.string().min(8).max(256).regex(/^[A-Za-z0-9_-]+$/),
    installationId: z.coerce.number().int().positive().safe(),
    state: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  })
  .strict();

export type VerifiedGitHubInstallation = {
  accountId: number;
  accountLogin: string;
  installationId: number;
  permissions: {
    contents: "read";
    issues: "read";
    metadata: "read";
  };
  repositories?: VerifiedGitHubRepository[];
  repositorySelection: "all" | "selected";
};

export type VerifiedGitHubRepository = {
  defaultBranch: string;
  fullName: string;
  private: boolean;
  repositoryId: number;
};

export interface GitHubInstallationVerifier {
  verify(input: {
    code: string;
    installationId: number;
  }): Promise<VerifiedGitHubInstallation>;
}

type CallbackDependencies = {
  actor(): Promise<GitHubInstallationActor | null>;
  baseUrl?: string;
  bind(
    actor: GitHubInstallationActor,
    installation: VerifiedGitHubInstallation,
  ): Promise<void>;
  clock?: { now(): Date };
  states: GitHubInstallationStateStore;
  verifier: GitHubInstallationVerifier;
};

function redirect(baseUrl: string, status: "connected" | "invalid"): Response {
  const destination = new URL("repositories", baseUrl);
  destination.searchParams.set("github", status);
  return Response.redirect(destination, 303);
}

export function createGitHubInstallationCallbackHandler(
  dependencies: CallbackDependencies,
) {
  return async function GET(request: Request): Promise<Response> {
    const requestUrl = new URL(request.url);
    const baseUrl = dependencies.baseUrl ?? `${requestUrl.origin}/`;
    try {
      const actor = await dependencies.actor();
      if (!actor) return redirect(baseUrl, "invalid");
      const parsed = callbackSchema.safeParse({
        code: requestUrl.searchParams.get("code"),
        installationId: requestUrl.searchParams.get("installation_id"),
        state: requestUrl.searchParams.get("state"),
      });
      if (!parsed.success) return redirect(baseUrl, "invalid");
      const consumed = await dependencies.states.consume({
        ...actor,
        at: (dependencies.clock ?? { now: () => new Date() })
          .now()
          .toISOString(),
        stateHash: githubInstallationStateHash(parsed.data.state),
      });
      if (!consumed) return redirect(baseUrl, "invalid");
      const installation = await dependencies.verifier.verify({
        code: parsed.data.code,
        installationId: parsed.data.installationId,
      });
      if (installation.installationId !== parsed.data.installationId) {
        return redirect(baseUrl, "invalid");
      }
      await dependencies.bind(actor, installation);
      return redirect(baseUrl, "connected");
    } catch {
      return redirect(baseUrl, "invalid");
    }
  };
}
