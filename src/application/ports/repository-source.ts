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

export interface RepositorySourceProvider {
  listAuthorizedRepositories(
    principal: AuthorizedPrincipal,
    input: ListAuthorizedRepositoriesInput,
  ): Promise<ListAuthorizedRepositoriesResult>;
  resolveRevision(
    principal: AuthorizedPrincipal,
    input: { commitSha: string; repositoryId: string },
  ): Promise<ResolvedRepositoryRevision>;
}
