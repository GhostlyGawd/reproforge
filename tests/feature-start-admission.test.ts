import { describe, expect, it, vi } from "vitest";

import { RepositoryStartPolicyError } from "@/application/case-service";
import {
  CompositeRepositoryStartAdmission,
  FeatureFlagRepositoryStartAdmission,
} from "@/infrastructure/operations/feature-start-admission";

const principal = {
  callerId: "principal_feature",
  principalId: "principal_feature",
  tenantId: "tenant_feature",
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
    id: "oracle-feature",
    root: { expected: 1, type: "exit_code" as const },
    version: 1,
  },
  kind: "github" as const,
  repositoryId: "repo_feature",
};
const resolved = {
  commitSha: source.commitSha,
  fullName: "synthetic-owner/private-canary",
  private: true,
  provider: "github" as const,
  repositoryId: source.repositoryId,
};

function admission(
  flags: ConstructorParameters<typeof FeatureFlagRepositoryStartAdmission>[0]["flags"],
  append = vi.fn(async () => undefined),
) {
  return {
    append,
    value: new FeatureFlagRepositoryStartAdmission({
      audit: { append },
      clock: { now: () => new Date("2026-07-20T23:00:00.000Z") },
      eventId: () => "audit_feature_denied",
      flags,
    }),
  };
}

describe("repository feature-policy admission", () => {
  it.each([
    {
      code: "REPOSITORY_STARTS_DISABLED" as const,
      flags: {
        disablePrivateRepositories: false,
        disableRepositoryStarts: true,
        disabledExecutionProfiles: [],
      },
    },
    {
      code: "PRIVATE_REPOSITORIES_DISABLED" as const,
      flags: {
        disablePrivateRepositories: true,
        disableRepositoryStarts: false,
        disabledExecutionProfiles: [],
      },
    },
    {
      code: "EXECUTION_PROFILE_DISABLED" as const,
      flags: {
        disablePrivateRepositories: false,
        disableRepositoryStarts: false,
        disabledExecutionProfiles: ["node24" as const],
      },
    },
  ])("denies $code without exposing repository details", async ({ code, flags }) => {
    const fixture = admission(flags);

    await expect(
      fixture.value.assertAllowed(principal, source, resolved),
    ).rejects.toEqual(
      expect.objectContaining({ code, retryable: true }),
    );
    expect(fixture.append).toHaveBeenCalledWith({
      action: "repository.start-denied",
      actorId: principal.principalId,
      eventId: "audit_feature_denied",
      metadata: {
        code,
        executionProfile: "node24",
        repositoryId: source.repositoryId,
      },
      occurredAt: "2026-07-20T23:00:00.000Z",
      outcome: "denied",
      targetId: source.repositoryId,
      targetType: "repository",
      tenantId: principal.tenantId,
    });
    expect(JSON.stringify(fixture.append.mock.calls)).not.toContain(
      resolved.fullName,
    );
  });

  it("admits enabled public and private supported profiles", async () => {
    const fixture = admission({
      disablePrivateRepositories: false,
      disableRepositoryStarts: false,
      disabledExecutionProfiles: [],
    });

    await expect(
      fixture.value.assertAllowed(principal, source, resolved),
    ).resolves.toBeUndefined();
    await expect(
      fixture.value.assertAllowed(principal, source, {
        ...resolved,
        private: false,
      }),
    ).resolves.toBeUndefined();
    expect(fixture.append).not.toHaveBeenCalled();
  });

  it("remains denied when the audit sink fails", async () => {
    const fixture = admission(
      {
        disablePrivateRepositories: false,
        disableRepositoryStarts: true,
        disabledExecutionProfiles: [],
      },
      vi.fn(async () => {
        throw new Error("postgresql://operator:secret@example.invalid/db");
      }),
    );

    const error = await fixture.value
      .assertAllowed(principal, source, resolved)
      .catch((caught) => caught);
    expect(error).toBeInstanceOf(RepositoryStartPolicyError);
    expect(JSON.stringify(error)).not.toContain("secret");
  });

  it("composes feature and runner gates in order and stops after denial", async () => {
    const first = vi.fn(async () => {
      throw new RepositoryStartPolicyError("REPOSITORY_STARTS_DISABLED");
    });
    const second = vi.fn(async () => undefined);
    const composite = new CompositeRepositoryStartAdmission([
      { assertAllowed: first },
      { assertAllowed: second },
    ]);

    await expect(
      composite.assertAllowed(principal, source, resolved),
    ).rejects.toMatchObject({ code: "REPOSITORY_STARTS_DISABLED" });
    expect(first).toHaveBeenCalledOnce();
    expect(second).not.toHaveBeenCalled();
  });
});
