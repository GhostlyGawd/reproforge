import { createHash } from "node:crypto";

import { z } from "zod";

import {
  immutableRepositorySourceSchema,
  nodeRepositoryProfileSchema,
  repositoryExecutionPlanSchema,
  sandboxCommandSchema,
  SANDBOX_ROOT,
  SANDBOX_WORKSPACE_ROOT,
  type ImmutableRepositorySource,
  type IsolatedSandboxSession,
  type NodeRepositoryProfile,
  type RepositoryExecutionPlan,
  type SandboxCommand,
} from "@/execution/contracts";
import type { DependencyMetadata } from "@/execution/dependency-preparation";
import type { SourceProvenance } from "@/execution/source-provenance";

const SOURCE_WORKSPACE = `${SANDBOX_WORKSPACE_ROOT}/source`;
const DEPENDENCY_WORKSPACE = `${SANDBOX_WORKSPACE_ROOT}/dependency-acquisition`;
const CACHE_PATH = `${SANDBOX_ROOT}/npm-cache`;

function npmExperimentArgs(
  script: string,
  pattern: string | undefined,
): string[] {
  return [
    "run",
    script,
    ...(pattern ? ["--", "--testNamePattern", pattern] : []),
  ];
}

function experimentCwd(root: string, profile: NodeRepositoryProfile): string {
  return profile.workspace ? `${root}/${profile.workspace}` : root;
}

export function buildNodeExecutionPlan(input: {
  profile: NodeRepositoryProfile;
  requiredRuns: number;
  source: ImmutableRepositorySource;
}): RepositoryExecutionPlan {
  const profile = nodeRepositoryProfileSchema.parse(input.profile);
  const source = immutableRepositorySourceSchema.parse(input.source);
  const requiredRuns = z.number().int().min(3).max(5).parse(input.requiredRuns);
  const commands: SandboxCommand[] = [
    sandboxCommandSchema.parse({
      args: [
        "ci",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--cache",
        CACHE_PATH,
        "--prefer-online",
      ],
      cwd: DEPENDENCY_WORKSPACE,
      executable: "npm",
      phase: "dependency-acquisition",
      timeoutMs: 120_000,
    }),
    sandboxCommandSchema.parse({
      args: [
        "ci",
        "--ignore-scripts",
        "--offline",
        "--no-audit",
        "--no-fund",
        "--cache",
        CACHE_PATH,
      ],
      cwd: SOURCE_WORKSPACE,
      executable: "npm",
      phase: "offline-install",
      timeoutMs: 120_000,
    }),
    sandboxCommandSchema.parse({
      args: npmExperimentArgs(profile.controlScript, profile.testNamePattern),
      cwd: experimentCwd(`${SANDBOX_WORKSPACE_ROOT}/control`, profile),
      executable: "npm",
      phase: "control",
      timeoutMs: 120_000,
    }),
    ...Array.from({ length: requiredRuns }, (_, index) =>
      sandboxCommandSchema.parse({
        args: npmExperimentArgs(
          profile.reproductionScript,
          profile.testNamePattern,
        ),
        cwd: experimentCwd(
          `${SANDBOX_WORKSPACE_ROOT}/candidate-${index + 1}`,
          profile,
        ),
        executable: "npm",
        phase: "candidate",
        timeoutMs: 120_000,
      }),
    ),
  ];
  return repositoryExecutionPlanSchema.parse({
    commands,
    policyVersion: "node-npm-v1",
    profile,
    requiredRuns,
    schemaVersion: "1.0",
    source,
    totalTimeoutMs: 900_000,
  });
}

export class WorkspacePreparationError extends Error {
  readonly code = "WORKSPACE_PREPARATION_FAILED" as const;

  constructor() {
    super("Clean experiment workspaces could not be prepared");
    this.name = "WorkspacePreparationError";
  }
}

export async function prepareExperimentWorkspaces(input: {
  networkPolicy: "deny-all";
  plan: RepositoryExecutionPlan;
  session: IsolatedSandboxSession;
  sourceWorkspace: string;
}): Promise<{
  candidateWorkspaces: string[];
  controlWorkspace: string;
}> {
  if (input.networkPolicy !== "deny-all" || input.sourceWorkspace !== SOURCE_WORKSPACE) {
    throw new WorkspacePreparationError();
  }
  const plan = repositoryExecutionPlanSchema.parse(input.plan);
  const controlWorkspace = `${SANDBOX_WORKSPACE_ROOT}/control`;
  const candidateWorkspaces = Array.from(
    { length: plan.requiredRuns },
    (_, index) => `${SANDBOX_WORKSPACE_ROOT}/candidate-${index + 1}`,
  );
  const workspaces = [controlWorkspace, ...candidateWorkspaces];
  for (const [index, workspace] of workspaces.entries()) {
    try {
      await input.session.makeDirectory(workspace);
      const copied = await input.session.run(
        sandboxCommandSchema.parse({
          args: [
            "-a",
            "--reflink=auto",
            `${input.sourceWorkspace}/.`,
            workspace,
          ],
          cwd: input.sourceWorkspace,
          executable: "cp",
          phase: index === 0 ? "control" : "candidate",
          timeoutMs: 120_000,
        }),
      );
      if (copied.exitCode !== 0) throw new WorkspacePreparationError();
    } catch (error) {
      if (error instanceof WorkspacePreparationError) throw error;
      throw new WorkspacePreparationError();
    }
  }
  return { candidateWorkspaces, controlWorkspace };
}

const semverOutput = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/;
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const executionEnvironmentProvenanceSchema = z
  .object({
    archiveSha256: sha256Schema,
    dependencyPolicyVersion: z.literal("node-lock-v1"),
    environmentHash: sha256Schema,
    executionPolicyVersion: z.literal("node-npm-v1"),
    lockfileSha256: sha256Schema,
    manifestSha256: sha256Schema,
    networkPolicy: z.literal("deny-all"),
    nodeVersion: z.string().regex(/^(?:22|24)\.[0-9]+\.[0-9]+$/),
    npmVersion: z.string().regex(semverOutput),
    packageJsonSha256: sha256Schema,
    provider: z.literal("vercel-sandbox"),
    runtime: z.enum(["node22", "node24"]),
    schemaVersion: z.literal("1.0"),
    sourceCommitSha: z.string().regex(/^[a-f0-9]{40}$/),
    sourcePolicyVersion: z.literal("source-archive-v1"),
    vcpus: z.literal(2),
  })
  .strict();

export type ExecutionEnvironmentProvenance = z.infer<
  typeof executionEnvironmentProvenanceSchema
>;

function readVersion(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
  } catch {
    throw new WorkspacePreparationError();
  }
}

export async function collectExecutionEnvironment(input: {
  dependency: DependencyMetadata;
  networkPolicy: "deny-all";
  profile: NodeRepositoryProfile;
  session: IsolatedSandboxSession;
  source: SourceProvenance;
}): Promise<ExecutionEnvironmentProvenance> {
  const profile = nodeRepositoryProfileSchema.parse(input.profile);
  if (input.networkPolicy !== "deny-all") throw new WorkspacePreparationError();
  const [node, npm] = await Promise.all([
    input.session.run(
      sandboxCommandSchema.parse({
        args: ["--version"],
        cwd: SOURCE_WORKSPACE,
        executable: "node",
        phase: "offline-install",
        timeoutMs: 10_000,
      }),
    ),
    input.session.run(
      sandboxCommandSchema.parse({
        args: ["--version"],
        cwd: SOURCE_WORKSPACE,
        executable: "npm",
        phase: "offline-install",
        timeoutMs: 10_000,
      }),
    ),
  ]);
  if (node.exitCode !== 0 || npm.exitCode !== 0) {
    throw new WorkspacePreparationError();
  }
  const rawNodeVersion = readVersion(node.stdout);
  const nodeMatch = /^v(22|24)\.([0-9]+)\.([0-9]+)$/.exec(rawNodeVersion);
  const npmVersion = readVersion(npm.stdout);
  if (!nodeMatch || nodeMatch[1] !== profile.nodeVersion || !semverOutput.test(npmVersion)) {
    throw new WorkspacePreparationError();
  }
  const sourceCommitSha = z.string().regex(/^[a-f0-9]{40}$/).parse(
    input.source.commitSha,
  );
  const base = {
    archiveSha256: sha256Schema.parse(input.source.archiveSha256),
    dependencyPolicyVersion: input.dependency.policyVersion,
    executionPolicyVersion: "node-npm-v1" as const,
    lockfileSha256: sha256Schema.parse(input.dependency.lockfileSha256),
    manifestSha256: sha256Schema.parse(input.source.manifestSha256),
    networkPolicy: "deny-all" as const,
    nodeVersion: rawNodeVersion.slice(1),
    npmVersion,
    packageJsonSha256: sha256Schema.parse(input.dependency.packageJsonSha256),
    provider: "vercel-sandbox" as const,
    runtime: `node${profile.nodeVersion}` as "node22" | "node24",
    sourceCommitSha,
    sourcePolicyVersion: input.source.policyVersion,
    vcpus: 2 as const,
  };
  const environmentHash = createHash("sha256")
    .update(JSON.stringify(base))
    .digest("hex");
  return executionEnvironmentProvenanceSchema.parse({
    ...base,
    environmentHash,
    schemaVersion: "1.0",
  });
}
