import { randomUUID } from "node:crypto";

import { z } from "zod";

import {
  RepositoryStartPolicyError,
  type RepositoryStartPolicyErrorCode,
} from "@/application/case-service";
import type { AuditSink } from "@/application/ports/production";
import type { RepositoryPrincipal } from "@/application/ports/repository-source";
import type {
  RepositorySource,
  RepositoryStartAdmission,
} from "@/application/repository-operations";
import type { RuntimeConfig } from "@/config/runtime";
import type { ImmutableRepositorySource } from "@/execution/contracts";

const flagsSchema = z
  .object({
    disablePrivateRepositories: z.boolean(),
    disableRepositoryStarts: z.boolean(),
    disabledExecutionProfiles: z
      .array(z.enum(["node22", "node24"]))
      .max(2)
      .transform((profiles) => [...new Set(profiles)].sort()),
  })
  .strict();

type RepositoryFeatureFlags = Pick<
  RuntimeConfig,
  | "disablePrivateRepositories"
  | "disableRepositoryStarts"
  | "disabledExecutionProfiles"
>;

type Dependencies = Readonly<{
  audit: AuditSink;
  clock?: { now(): Date };
  eventId?: () => string;
  flags: RepositoryFeatureFlags;
}>;

export class CompositeRepositoryStartAdmission
  implements RepositoryStartAdmission
{
  constructor(private readonly admissions: readonly RepositoryStartAdmission[]) {
    if (admissions.length < 1 || admissions.length > 8) {
      throw new TypeError("A bounded repository admission chain is required");
    }
  }

  async assertAllowed(
    principal: RepositoryPrincipal,
    source: RepositorySource,
    resolvedSource: ImmutableRepositorySource,
  ): Promise<void> {
    for (const admission of this.admissions) {
      await admission.assertAllowed(principal, source, resolvedSource);
    }
  }
}

export class FeatureFlagRepositoryStartAdmission
  implements RepositoryStartAdmission
{
  private readonly clock: { now(): Date };
  private readonly eventId: () => string;
  private readonly flags: z.output<typeof flagsSchema>;

  constructor(private readonly dependencies: Dependencies) {
    this.clock = dependencies.clock ?? { now: () => new Date() };
    this.eventId =
      dependencies.eventId ??
      (() => `audit_feature_denied_${randomUUID().replaceAll("-", "")}`);
    this.flags = flagsSchema.parse(dependencies.flags);
  }

  async assertAllowed(
    principal: RepositoryPrincipal,
    source: RepositorySource,
    resolvedSource: ImmutableRepositorySource,
  ): Promise<void> {
    const executionProfile = `node${source.executionProfile.nodeVersion}` as
      | "node22"
      | "node24";
    const code = this.denialCode(executionProfile, resolvedSource.private);
    if (!code) return;

    try {
      await this.dependencies.audit.append({
        action: "repository.start-denied",
        actorId: principal.principalId,
        eventId: this.eventId(),
        metadata: {
          code,
          executionProfile,
          repositoryId: source.repositoryId,
        },
        occurredAt: this.clock.now().toISOString(),
        outcome: "denied",
        targetId: source.repositoryId,
        targetType: "repository",
        tenantId: principal.tenantId,
      });
    } catch {
      // An unavailable audit sink must never admit a disabled start.
    }
    throw new RepositoryStartPolicyError(code);
  }

  private denialCode(
    executionProfile: "node22" | "node24",
    privateRepository: boolean,
  ): RepositoryStartPolicyErrorCode | null {
    if (this.flags.disableRepositoryStarts) {
      return "REPOSITORY_STARTS_DISABLED";
    }
    if (privateRepository && this.flags.disablePrivateRepositories) {
      return "PRIVATE_REPOSITORIES_DISABLED";
    }
    if (this.flags.disabledExecutionProfiles.includes(executionProfile)) {
      return "EXECUTION_PROFILE_DISABLED";
    }
    return null;
  }
}
