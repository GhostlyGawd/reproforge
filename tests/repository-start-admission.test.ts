import { describe, expect, it, vi } from "vitest";

import { RepositoryStartUnavailableError } from "@/application/case-service";
import { SandboxRunnerStartAdmission } from "@/infrastructure/operations/repository-start-admission";

const principal = {
  callerId: "principal_admission",
  principalId: "principal_admission",
  tenantId: "tenant_admission",
};
const source = {
  commitSha: "a".repeat(40),
  executionProfile: {
    controlScript: "test:control",
    ecosystem: "node" as const,
    lockfile: "package-lock.json" as const,
    nodeVersion: "24" as const,
    packageManager: "npm" as const,
    reproductionScript: "test:reproduce",
  },
  failureOracle: {
    id: "oracle-admission",
    root: { expected: 1, type: "exit_code" as const },
    version: 1,
  },
  kind: "github" as const,
  repositoryId: "repo_admission",
};

describe("repository start admission", () => {
  it("admits a new start only after the runner capability is ready", async () => {
    const append = vi.fn(async () => undefined);
    const admission = new SandboxRunnerStartAdmission({
      audit: { append },
      eventId: () => "audit_admission_ready",
      probe: {
        check: vi.fn(async () => ({
          code: "RUNNER_READY",
          status: "ready" as const,
        })),
      },
    });

    await expect(admission.assertAllowed(principal, source)).resolves.toBeUndefined();
    expect(append).not.toHaveBeenCalled();
  });

  it("blocks degraded starts and records a sanitized denial", async () => {
    const append = vi.fn(async () => undefined);
    const admission = new SandboxRunnerStartAdmission({
      audit: { append },
      clock: { now: () => new Date("2026-07-20T21:30:00.000Z") },
      eventId: () => "audit_admission_denied",
      probe: {
        check: vi.fn(async () => ({
          code: "RUNNER_UNAVAILABLE",
          status: "unavailable" as const,
        })),
      },
    });

    await expect(admission.assertAllowed(principal, source)).rejects.toEqual(
      expect.objectContaining({
        code: "RUNNER_UNAVAILABLE",
        retryable: true,
      }),
    );
    expect(append).toHaveBeenCalledWith({
      action: "repository.start-denied",
      actorId: principal.principalId,
      eventId: "audit_admission_denied",
      metadata: {
        code: "RUNNER_UNAVAILABLE",
        repositoryId: source.repositoryId,
      },
      occurredAt: "2026-07-20T21:30:00.000Z",
      outcome: "denied",
      targetId: source.repositoryId,
      targetType: "repository",
      tenantId: principal.tenantId,
    });
  });

  it("still blocks when the capability check and denial audit both fail", async () => {
    const admission = new SandboxRunnerStartAdmission({
      audit: {
        append: vi.fn(async () => {
          throw new Error("postgresql://operator:secret@example.invalid/db");
        }),
      },
      eventId: () => "audit_admission_failed",
      probe: {
        check: vi.fn(async () => {
          throw new Error("VERCEL_OIDC_TOKEN=secret");
        }),
      },
    });

    const error = await admission.assertAllowed(principal, source).catch((caught) => caught);
    expect(error).toBeInstanceOf(RepositoryStartUnavailableError);
    expect(JSON.stringify(error)).not.toContain("secret");
  });
});
