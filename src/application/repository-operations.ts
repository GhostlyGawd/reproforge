import { z } from "zod";

import type { CancellationRequestResult } from "@/application/ports/production";
import type { RepositoryPrincipal } from "@/application/ports/repository-source";
import type {
  ExportResult,
  ReproductionSnapshot,
  StartResult,
} from "@/application/reproduction-contracts";
import { failureOracleSchema } from "@/domain/oracle";
import {
  nodeRepositoryProfileSchema,
  repositoryIssueEvidenceSchema,
} from "@/execution/contracts";

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

export const repositoryStartSourceSchema = z
  .object({
    commitSha: z.string().regex(/^[a-f0-9]{40}$/),
    executionProfile: nodeRepositoryProfileSchema,
    failureOracle: failureOracleSchema,
    issueEvidence: repositoryIssueEvidenceSchema.optional(),
    kind: z.literal("github"),
    repositoryId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  })
  .strict();

export type RepositorySource = z.infer<typeof repositoryStartSourceSchema>;

export interface RepositoryStartAdmission {
  assertAllowed(
    principal: RepositoryPrincipal,
    source: RepositorySource,
  ): Promise<void>;
}

export const startRepositoryReproductionInputSchema = z
  .object({
    budget: z
      .object({
        maxToolCalls: z.number().int().min(1).max(12).default(6),
        requiredRuns: z.number().int().min(3).max(5).default(3),
      })
      .strict()
      .default({ maxToolCalls: 6, requiredRuns: 3 }),
    idempotencyKey: z.string().min(1).max(128),
    source: repositoryStartSourceSchema,
  })
  .strict();

export type StartRepositoryReproductionInput = z.input<
  typeof startRepositoryReproductionInputSchema
>;

export interface RepositoryOperations {
  cancelReproduction(
    principal: RepositoryPrincipal,
    input: { jobId: string },
  ): Promise<CancellationRequestResult>;
  exportReproBundle(
    principal: RepositoryPrincipal,
    input: { caseId: string },
  ): Promise<ExportResult>;
  getReproduction(
    principal: RepositoryPrincipal,
    input: { caseId: string },
  ): Promise<ReproductionSnapshot>;
  listAuthorizedRepositories(
    principal: RepositoryPrincipal,
    input: ListAuthorizedRepositoriesInput,
  ): Promise<ListAuthorizedRepositoriesResult>;
  startRepositoryReproduction(
    principal: RepositoryPrincipal,
    input: StartRepositoryReproductionInput,
  ): Promise<StartResult>;
}
