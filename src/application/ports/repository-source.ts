import type { AuthorizedPrincipal } from "@/application/authorization";
import type {
  ListAuthorizedRepositoriesInput,
  ListAuthorizedRepositoriesResult,
} from "@/application/repository-operations";

export type ResolvedRepositoryRevision = {
  commitSha: string;
  defaultBranch: string;
  fullName: string;
  private: boolean;
  provider: "github";
  repositoryId: string;
};

export type RepositoryPrincipal = Pick<
  AuthorizedPrincipal,
  "callerId" | "principalId" | "tenantId"
>;

export interface RepositorySourceProvider {
  listAuthorizedRepositories(
    principal: RepositoryPrincipal,
    input: ListAuthorizedRepositoriesInput,
  ): Promise<ListAuthorizedRepositoriesResult>;
  resolveRevision(
    principal: RepositoryPrincipal,
    input: { commitSha: string; repositoryId: string },
  ): Promise<ResolvedRepositoryRevision>;
}

export type EphemeralRepositoryArchiveCredential = {
  authorizationHeader: string;
  expiresAt: string;
};

export interface RepositoryArchiveCredentialProvider {
  withArchiveCredential<Result>(
    principal: RepositoryPrincipal,
    input: {
      commitSha: string;
      fullName: string;
      repositoryId: string;
    },
    consume: (
      credential: EphemeralRepositoryArchiveCredential,
    ) => Promise<Result>,
  ): Promise<Result>;
}
