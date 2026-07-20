import { z } from "zod";

export const SANDBOX_ROOT = "/vercel/sandbox" as const;
export const SANDBOX_WORKSPACE_ROOT = `${SANDBOX_ROOT}/workspaces` as const;

const noControlCharacters = (value: string) =>
  !/[\u0000-\u001f\u007f]/u.test(value);

function isSafeRelativePath(value: string): boolean {
  if (
    value.length === 0 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    !noControlCharacters(value)
  ) {
    return false;
  }
  return value
    .split("/")
    .every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function isSandboxWorkspacePath(value: string): boolean {
  if (!value.startsWith(`${SANDBOX_WORKSPACE_ROOT}/`)) return false;
  return isSafeRelativePath(value.slice(SANDBOX_WORKSPACE_ROOT.length + 1));
}

const scriptNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9:._/-]*$/)
  .refine(noControlCharacters, "script name contains a control character");

const workspaceSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(isSafeRelativePath, "workspace must stay below the repository root");

export const nodeRepositoryProfileSchema = z
  .object({
    controlScript: scriptNameSchema,
    ecosystem: z.literal("node"),
    lockfile: z.literal("package-lock.json"),
    nodeVersion: z.enum(["22", "24"]),
    packageManager: z.literal("npm"),
    reproductionScript: scriptNameSchema,
    testNamePattern: z
      .string()
      .min(1)
      .max(256)
      .refine(noControlCharacters, "test pattern contains a control character")
      .optional(),
    workspace: workspaceSchema.optional(),
  })
  .strict();

export type NodeRepositoryProfile = z.infer<
  typeof nodeRepositoryProfileSchema
>;

export const immutableRepositorySourceSchema = z
  .object({
    commitSha: z.string().regex(/^[a-f0-9]{40}$/),
    fullName: z
      .string()
      .min(3)
      .max(255)
      .regex(/^[^/\s]+\/[^/\s]+$/),
    private: z.boolean(),
    provider: z.literal("github"),
    repositoryId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  })
  .strict();

export type ImmutableRepositorySource = z.infer<
  typeof immutableRepositorySourceSchema
>;

export const sandboxCreateRequestSchema = z
  .object({
    networkPolicy: z.literal("deny-all"),
    runtime: z.enum(["node22", "node24"]),
    timeoutMs: z.number().int().min(1_000).max(900_000),
    vcpus: z.literal(2),
  })
  .strict();

export type SandboxCreateRequest = z.infer<typeof sandboxCreateRequestSchema>;

export const sandboxNetworkPolicySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("deny-all") }).strict(),
  z
    .object({
      allowedHosts: z
        .array(
          z
            .string()
            .min(1)
            .max(253)
            .regex(/^(?:\*\.)?[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/),
        )
        .min(1)
        .max(16),
      kind: z.literal("allow-hosts"),
      phase: z.enum(["github-acquisition", "npm-acquisition"]),
    })
    .strict(),
]);

export type SandboxNetworkPolicy = z.infer<typeof sandboxNetworkPolicySchema>;

export const sandboxCommandSchema = z
  .object({
    args: z
      .array(
        z
          .string()
          .max(4_096)
          .refine(noControlCharacters, "argument contains a control character"),
      )
      .max(256),
    cwd: z
      .string()
      .max(1_024)
      .refine(isSandboxWorkspacePath, "command cwd must stay in a sandbox workspace"),
    executable: z.enum([
      "cp",
      "curl",
      "find",
      "git",
      "mkdir",
      "node",
      "npm",
      "rm",
      "sha256sum",
      "tar",
    ]),
    phase: z.enum([
      "source-acquisition",
      "dependency-acquisition",
      "offline-install",
      "control",
      "candidate",
      "artifact-export",
      "cleanup",
    ]),
    timeoutMs: z.number().int().min(1).max(120_000),
  })
  .strict();

export type SandboxCommand = z.infer<typeof sandboxCommandSchema>;

export const repositoryExecutionPlanSchema = z
  .object({
    commands: z.array(sandboxCommandSchema).min(4).max(12),
    policyVersion: z.literal("node-npm-v1"),
    profile: nodeRepositoryProfileSchema,
    requiredRuns: z.number().int().min(1).max(5),
    schemaVersion: z.literal("1.0"),
    source: immutableRepositorySourceSchema,
    totalTimeoutMs: z.number().int().min(1_000).max(900_000),
  })
  .strict()
  .superRefine((plan, context) => {
    const phases = plan.commands.map((command) => command.phase);
    const dependencies = phases
      .map((phase, index) => ({ index, phase }))
      .filter(({ phase }) => phase === "dependency-acquisition");
    const installs = phases
      .map((phase, index) => ({ index, phase }))
      .filter(({ phase }) => phase === "offline-install");
    const controls = phases
      .map((phase, index) => ({ index, phase }))
      .filter(({ phase }) => phase === "control");
    const candidates = phases
      .map((phase, index) => ({ index, phase }))
      .filter(({ phase }) => phase === "candidate");

    if (dependencies.length === 0) {
      context.addIssue({
        code: "custom",
        message: "execution plan requires dependency acquisition",
        path: ["commands"],
      });
    }
    if (installs.length !== 1) {
      context.addIssue({
        code: "custom",
        message: "execution plan requires exactly one offline install",
        path: ["commands"],
      });
    }
    if (controls.length !== 1) {
      context.addIssue({
        code: "custom",
        message: "execution plan requires exactly one negative control",
        path: ["commands"],
      });
    }
    if (candidates.length !== plan.requiredRuns) {
      context.addIssue({
        code: "custom",
        message: "candidate commands must equal requiredRuns",
        path: ["commands"],
      });
    }

    const firstDependency = dependencies[0]?.index;
    const install = installs[0]?.index;
    const control = controls[0]?.index;
    const firstCandidate = candidates[0]?.index;
    if (
      firstDependency !== undefined &&
      install !== undefined &&
      control !== undefined &&
      firstCandidate !== undefined &&
      !(
        firstDependency < install &&
        install < control &&
        control < firstCandidate
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "acquisition, offline install, control, and candidates are ordered",
        path: ["commands"],
      });
    }
  });

export type RepositoryExecutionPlan = z.infer<
  typeof repositoryExecutionPlanSchema
>;

export type SandboxCommandResult = {
  durationMs: number;
  exitCode: number;
  stderr: Uint8Array;
  stdout: Uint8Array;
};

export type SandboxFile = {
  content: Uint8Array;
  path: string;
};

export type SandboxUsage = {
  activeCpuMs: number | null;
  networkEgressBytes: number | null;
  networkIngressBytes: number | null;
};

export interface IsolatedSandboxSession {
  readonly sandboxId: string;
  makeDirectory(path: string): Promise<void>;
  readFile(path: string): Promise<Uint8Array | null>;
  run(
    command: SandboxCommand,
    options?: { signal?: AbortSignal },
  ): Promise<SandboxCommandResult>;
  setNetworkPolicy(policy: SandboxNetworkPolicy): Promise<void>;
  stop(): Promise<void>;
  usage(): Promise<SandboxUsage>;
  writeFiles(files: SandboxFile[]): Promise<void>;
}

export interface IsolatedSandboxProvider {
  create(request: SandboxCreateRequest): Promise<IsolatedSandboxSession>;
}
