import type { RepositoryArchiveCredentialProvider } from "@/application/ports/repository-source";
import { createCase } from "@/domain/case";
import type { RepositoryProofResult } from "@/execution/repository-proof";
import { IsolatedRepositoryRunner } from "@/execution/isolated-repository-runner";
import type { QuarantineRecord } from "@/execution/sandbox-lifecycle";
import { VercelSandboxProvider } from "@/execution/vercel-sandbox";

export const PUBLIC_REPOSITORY_CANARY_COMMIT =
  "d3d69d4c5222bb7f4e6cded27a965258247942b2";
export const PUBLIC_REPOSITORY_CANARY_SECRET =
  "SYNTHETIC_REPROFORGE_PUBLIC_CANARY_SECRET";

const unavailableCredentialProvider: RepositoryArchiveCredentialProvider = {
  async withArchiveCredential<Result>(): Promise<Result> {
    throw new Error("The public canary must not request a GitHub credential");
  },
};

export async function runPublicRepositoryCanary(): Promise<{
  proof: RepositoryProofResult;
  quarantine: QuarantineRecord[];
}> {
  const quarantine: QuarantineRecord[] = [];
  const startedAt = new Date();
  const runner = new IsolatedRepositoryRunner({
    credentialProvider: unavailableCredentialProvider,
    provider: new VercelSandboxProvider(),
    quarantine: {
      record: async (record) => {
        quarantine.push(record);
      },
    },
  });
  const proof = await runner.execute({
    attemptId: "public_repository_canary_attempt",
    budget: { maxToolCalls: 6, requiredRuns: 3 },
    case: createCase("public_repository_canary_case", startedAt),
    issueEvidence: {
      number: 1,
      title: "Deterministic public repository canary",
    },
    oracle: {
      id: "public-repository-canary-v1",
      root: {
        children: [
          { expected: 1, type: "exit_code" },
          {
            stream: "stderr",
            type: "output_contains",
            value: "REPROFORGE_CANARY_FAILURE",
          },
        ],
        type: "all",
      },
      version: 1,
    },
    principal: {
      callerId: "public_canary_caller",
      principalId: "public_canary_principal",
      tenantId: "public_canary_tenant",
    },
    profile: {
      controlScript: "test:control",
      ecosystem: "node",
      lockfile: "package-lock.json",
      nodeVersion: "24",
      packageManager: "npm",
      reproductionScript: "test:reproduce",
    },
    secrets: [PUBLIC_REPOSITORY_CANARY_SECRET],
    source: {
      commitSha: PUBLIC_REPOSITORY_CANARY_COMMIT,
      fullName: "GhostlyGawd/reproforge-canary",
      private: false,
      provider: "github",
      repositoryId: "public_repository_canary",
    },
  });
  return { proof, quarantine };
}
