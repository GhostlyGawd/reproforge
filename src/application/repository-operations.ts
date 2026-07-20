import type { AuthorizedPrincipal } from "@/application/authorization";
import type { CancellationRequestResult } from "@/application/ports/production";
import type {
  ExportResult,
  ReproductionSnapshot,
  StartResult,
} from "@/application/reproduction-contracts";

export type AuthorizedRepository = {
  defaultBranch: string;
  fullName: string;
  private: boolean;
  repositoryId: string;
};

export type ListAuthorizedRepositoriesInput = {
  cursor?: string;
  limit?: number;
};

export type ListAuthorizedRepositoriesResult = {
  nextCursor: string | null;
  repositories: AuthorizedRepository[];
  tenantId: string;
};

export type RepositorySource = {
  commitSha: string;
  executionProfile: {
    ecosystem: "node";
    networkPolicy: "none";
    packageManager: "npm";
    testEntrypoint: "npm-test";
  };
  issueEvidence?: {
    number: number;
    title?: string;
  };
  kind: "github";
  repositoryId: string;
};

export type StartRepositoryReproductionInput = {
  budget?: {
    maxToolCalls: number;
    requiredRuns: number;
  };
  idempotencyKey: string;
  source: RepositorySource;
};

export interface RepositoryOperations {
  cancelReproduction(
    principal: AuthorizedPrincipal,
    input: { jobId: string },
  ): Promise<CancellationRequestResult>;
  exportReproBundle(
    principal: AuthorizedPrincipal,
    input: { caseId: string },
  ): Promise<ExportResult>;
  getReproduction(
    principal: AuthorizedPrincipal,
    input: { caseId: string },
  ): Promise<ReproductionSnapshot>;
  listAuthorizedRepositories(
    principal: AuthorizedPrincipal,
    input: ListAuthorizedRepositoriesInput,
  ): Promise<ListAuthorizedRepositoriesResult>;
  startRepositoryReproduction(
    principal: AuthorizedPrincipal,
    input: StartRepositoryReproductionInput,
  ): Promise<StartResult>;
}
