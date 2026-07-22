import type { AuthorizedRepository } from "@/application/repository-operations";
import type {
  GitHubInstallationActor,
  GitHubInstallationStateStore,
} from "@/github/installation-state";
import type { VerifiedGitHubInstallation } from "@/github/callback";
import type { GitHubWebhookEnvelope } from "@/github/webhook";

export type GitHubRepositoryAuthorizationStatus =
  | "ACTIVE"
  | "REMOVED"
  | "SUSPENDED";

export type GitHubRepositoryAuthorization = AuthorizedRepository & {
  installationId: number;
  permissions: {
    contents: "read";
    issues: "read";
    metadata: "read";
  };
  providerRepositoryId: number;
  status: GitHubRepositoryAuthorizationStatus;
  tenantId: string;
};

export type GitHubRepositoryPage = {
  nextCursor: string | null;
  repositories: GitHubRepositoryAuthorization[];
};

export interface GitHubAuthorizationStore
  extends GitHubInstallationStateStore {
  bind(
    actor: GitHubInstallationActor,
    installation: VerifiedGitHubInstallation,
  ): Promise<void>;
  findRepository(
    tenantId: string,
    repositoryId: string,
  ): Promise<GitHubRepositoryAuthorization | null>;
  listRepositories(input: {
    cursor?: string;
    limit: number;
    tenantId: string;
  }): Promise<GitHubRepositoryPage>;
  processWebhook(
    envelope: GitHubWebhookEnvelope,
    options?: { installation?: VerifiedGitHubInstallation },
  ): Promise<"accepted" | "duplicate">;
}
