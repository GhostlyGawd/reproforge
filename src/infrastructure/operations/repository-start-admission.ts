import { randomUUID } from "node:crypto";

import { RepositoryStartUnavailableError } from "@/application/case-service";
import type { HealthProbe } from "@/application/health";
import type { AuditSink } from "@/application/ports/production";
import type { RepositoryPrincipal } from "@/application/ports/repository-source";
import type {
  RepositorySource,
  RepositoryStartAdmission,
} from "@/application/repository-operations";

type Dependencies = Readonly<{
  audit: AuditSink;
  clock?: { now(): Date };
  eventId?: () => string;
  probe: Pick<HealthProbe, "check">;
}>;

export class SandboxRunnerStartAdmission implements RepositoryStartAdmission {
  private readonly clock: { now(): Date };
  private readonly eventId: () => string;

  constructor(private readonly dependencies: Dependencies) {
    this.clock = dependencies.clock ?? { now: () => new Date() };
    this.eventId =
      dependencies.eventId ??
      (() => `audit_runner_denied_${randomUUID().replaceAll("-", "")}`);
  }

  async assertAllowed(
    principal: RepositoryPrincipal,
    source: RepositorySource,
  ): Promise<void> {
    let ready = false;
    try {
      ready = (await this.dependencies.probe.check()).status === "ready";
    } catch {
      // Capability failures remain fail-closed and expose no provider detail.
    }
    if (ready) return;

    try {
      await this.dependencies.audit.append({
        action: "repository.start-denied",
        actorId: principal.principalId,
        eventId: this.eventId(),
        metadata: {
          code: "RUNNER_UNAVAILABLE",
          repositoryId: source.repositoryId,
        },
        occurredAt: this.clock.now().toISOString(),
        outcome: "denied",
        targetId: source.repositoryId,
        targetType: "repository",
        tenantId: principal.tenantId,
      });
    } catch {
      // Audit degradation must never turn a denied start into an admitted one.
    }
    throw new RepositoryStartUnavailableError();
  }
}
