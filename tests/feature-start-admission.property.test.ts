import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";

import { FeatureFlagRepositoryStartAdmission } from "@/infrastructure/operations/feature-start-admission";

const principal = {
  callerId: "principal_feature_property",
  principalId: "principal_feature_property",
  tenantId: "tenant_feature_property",
};

describe("repository feature-policy admission properties", () => {
  it("never admits a generated source disabled by any kill switch", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          disablePrivateRepositories: fc.boolean(),
          disableRepositoryStarts: fc.boolean(),
          disabledNode22: fc.boolean(),
          disabledNode24: fc.boolean(),
          nodeVersion: fc.constantFrom("22" as const, "24" as const),
          private: fc.boolean(),
        }),
        async (input) => {
          const append = vi.fn(async () => undefined);
          const admission = new FeatureFlagRepositoryStartAdmission({
            audit: { append },
            eventId: () => "audit_feature_property",
            flags: {
              disablePrivateRepositories: input.disablePrivateRepositories,
              disableRepositoryStarts: input.disableRepositoryStarts,
              disabledExecutionProfiles: [
                ...(input.disabledNode22 ? (["node22"] as const) : []),
                ...(input.disabledNode24 ? (["node24"] as const) : []),
              ],
            },
          });
          const source = {
            commitSha: "a".repeat(40),
            executionProfile: {
              controlScript: "test:control",
              ecosystem: "node" as const,
              lockfile: "package-lock.json" as const,
              nodeVersion: input.nodeVersion,
              packageManager: "npm" as const,
              reproductionScript: "test:reproduce",
            },
            failureOracle: {
              id: "oracle-feature-property",
              root: { expected: 1, type: "exit_code" as const },
              version: 1,
            },
            kind: "github" as const,
            repositoryId: "repo_feature_property",
          };
          const disabled =
            input.disableRepositoryStarts ||
            (input.private && input.disablePrivateRepositories) ||
            (input.nodeVersion === "22"
              ? input.disabledNode22
              : input.disabledNode24);

          const outcome = await admission
            .assertAllowed(principal, source, {
              commitSha: source.commitSha,
              fullName: "synthetic-owner/generated-repository",
              private: input.private,
              provider: "github",
              repositoryId: source.repositoryId,
            })
            .then(
              () => "admitted" as const,
              () => "denied" as const,
            );

          expect(outcome).toBe(disabled ? "denied" : "admitted");
          expect(append).toHaveBeenCalledTimes(disabled ? 1 : 0);
        },
      ),
      { numRuns: 500, seed: 8_406_004 },
    );
  });
});
