import { createHash } from "node:crypto";

import { z } from "zod";

import {
  repositoryExecutionPlanSchema,
  sandboxCommandSchema,
  SANDBOX_ROOT,
  type IsolatedSandboxSession,
  type RepositoryExecutionPlan,
  type SandboxCommand,
} from "@/execution/contracts";
import type { ExecutionEnvironmentProvenance } from "@/execution/execution-planning";
import { RUNNER_SUPERVISOR_SOURCE } from "@/execution/supervisor-script";
import { runResultSchema, type RunResult } from "@/domain/run";

export const EXECUTION_LIMITS = Object.freeze({
  commandTimeoutMs: 120_000,
  maxArtifactBytes: 100 * 1024 * 1024,
  maxMemoryBytes: 4 * 1024 * 1024 * 1024,
  maxOutputBytes: 2 * 1024 * 1024,
  maxProcesses: 128,
  maxRuns: 5,
  maxToolCalls: 12,
  maxTotalAttemptMs: 900_000,
  maxWorkspaceBytes: 500 * 1024 * 1024,
  policyVersion: "sandbox-limits-v1" as const,
  vcpus: 2,
});

export type ExecutionLimitCode =
  | "ARTIFACT_LIMIT_EXCEEDED"
  | "ATTEMPT_TIMEOUT"
  | "COMMAND_TIMEOUT"
  | "MEMORY_LIMIT_EXCEEDED"
  | "OUTPUT_INVALID"
  | "PROCESS_LIMIT_EXCEEDED"
  | "PROVIDER_INTERRUPTED"
  | "WORKSPACE_LIMIT_EXCEEDED";

export class ExecutionLimitError extends Error {
  constructor(readonly code: ExecutionLimitCode) {
    super("The isolated experiment stopped at a configured execution boundary");
    this.name = "ExecutionLimitError";
  }
}

export type CapturedOutput = {
  originalBytes: number;
  sha256: string;
  text: string;
  truncated: boolean;
};

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function redact(value: string, secrets: string[]): string {
  let sanitized = value;
  const known = [...new Set(secrets.filter((secret) => secret.length > 0))].sort(
    (left, right) => right.length - left.length,
  );
  if (known.length > 0) {
    sanitized = sanitized.replace(
      new RegExp(known.map(escapeRegex).join("|"), "g"),
      "[REDACTED]",
    );
  }
  return sanitized
    .replace(/\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{8,}\b/g, "Bearer [REDACTED]");
}

export function captureBoundedOutput(
  bytes: Uint8Array,
  maxBytes: number,
  secrets: string[],
): CapturedOutput {
  const limit = z.number().int().nonnegative().parse(maxBytes);
  const retained = bytes.slice(0, limit);
  return {
    originalBytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    text: redact(new TextDecoder().decode(retained), secrets),
    truncated: bytes.byteLength > retained.byteLength,
  };
}

export function enforceArtifactBudget(
  artifacts: Array<{ bytes: { byteLength: number }; path: string }>,
): { artifactBytes: number; artifactCount: number } {
  if (artifacts.length > 1_000) {
    throw new ExecutionLimitError("ARTIFACT_LIMIT_EXCEEDED");
  }
  const seen = new Set<string>();
  let artifactBytes = 0;
  for (const artifact of artifacts) {
    if (
      artifact.path.length === 0 ||
      artifact.path.length > 1_024 ||
      artifact.path.startsWith("/") ||
      artifact.path.includes("\\") ||
      artifact.path
        .split("/")
        .some((segment) => segment.length === 0 || segment === "." || segment === "..") ||
      seen.has(artifact.path) ||
      !Number.isSafeInteger(artifact.bytes.byteLength) ||
      artifact.bytes.byteLength < 0
    ) {
      throw new ExecutionLimitError("ARTIFACT_LIMIT_EXCEEDED");
    }
    seen.add(artifact.path);
    artifactBytes += artifact.bytes.byteLength;
    if (
      !Number.isSafeInteger(artifactBytes) ||
      artifactBytes > EXECUTION_LIMITS.maxArtifactBytes
    ) {
      throw new ExecutionLimitError("ARTIFACT_LIMIT_EXCEEDED");
    }
  }
  return { artifactBytes, artifactCount: artifacts.length };
}

export const capturedOutputSchema = z
  .object({
    originalBytes: z.number().int().nonnegative().safe(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    text: z.string().max(EXECUTION_LIMITS.maxOutputBytes),
    truncated: z.boolean(),
  })
  .strict();

const supervisorResultSchema = z
  .object({
    durationMs: z.number().int().nonnegative().max(EXECUTION_LIMITS.commandTimeoutMs + 5_000),
    exitCode: z.number().int().min(-1).max(255),
    stderr: capturedOutputSchema,
    stdout: capturedOutputSchema,
    termination: z
      .enum([
        "timeout",
        "process-limit",
        "memory-limit",
        "workspace-limit",
        "provider-interrupted",
      ])
      .nullable(),
  })
  .strict()
  .superRefine((result, context) => {
    for (const stream of ["stdout", "stderr"] as const) {
      const capture = result[stream];
      const retainedBytes = Buffer.byteLength(capture.text, "utf8");
      if (
        retainedBytes > Math.ceil(EXECUTION_LIMITS.maxOutputBytes / 2) * 3 ||
        capture.originalBytes < retainedBytes ||
        (capture.truncated && capture.originalBytes <= retainedBytes)
      ) {
        context.addIssue({
          code: "custom",
          message: "invalid bounded output",
          path: [stream],
        });
      }
    }
  });

type SupervisorResult = z.infer<typeof supervisorResultSchema>;

export type BoundedRun = {
  capture: { stderr: CapturedOutput; stdout: CapturedOutput };
  role: "candidate" | "control";
  run: RunResult;
};

export const boundedRunSchema = z
  .object({
    capture: z
      .object({
        stderr: capturedOutputSchema,
        stdout: capturedOutputSchema,
      })
      .strict(),
    role: z.enum(["candidate", "control"]),
    run: runResultSchema,
  })
  .strict();

export type BoundedExperimentResult = {
  candidates: BoundedRun[];
  control: BoundedRun;
  limitsPolicyVersion: "sandbox-limits-v1";
  totalDurationMs: number;
};

export const boundedExperimentResultSchema = z
  .object({
    candidates: z.array(boundedRunSchema).min(1).max(EXECUTION_LIMITS.maxRuns),
    control: boundedRunSchema,
    limitsPolicyVersion: z.literal("sandbox-limits-v1"),
    totalDurationMs: z
      .number()
      .int()
      .nonnegative()
      .max(EXECUTION_LIMITS.maxTotalAttemptMs),
  })
  .strict()
  .superRefine((result, context) => {
    if (result.control.role !== "control") {
      context.addIssue({
        code: "custom",
        message: "control run must have the control role",
        path: ["control", "role"],
      });
    }
    result.candidates.forEach((candidate, index) => {
      if (candidate.role !== "candidate") {
        context.addIssue({
          code: "custom",
          message: "candidate run must have the candidate role",
          path: ["candidates", index, "role"],
        });
      }
    });
  });

const SUPERVISOR_DIRECTORY = `${SANDBOX_ROOT}/reproforge`;
const SUPERVISOR_PATH = `${SUPERVISOR_DIRECTORY}/runner-supervisor.mjs`;

function mapTermination(termination: SupervisorResult["termination"]): never {
  switch (termination) {
    case "timeout":
      throw new ExecutionLimitError("COMMAND_TIMEOUT");
    case "process-limit":
      throw new ExecutionLimitError("PROCESS_LIMIT_EXCEEDED");
    case "memory-limit":
      throw new ExecutionLimitError("MEMORY_LIMIT_EXCEEDED");
    case "workspace-limit":
      throw new ExecutionLimitError("WORKSPACE_LIMIT_EXCEEDED");
    case "provider-interrupted":
    case null:
      throw new ExecutionLimitError("PROVIDER_INTERRUPTED");
  }
}

function displayCommand(command: SandboxCommand): string {
  return [command.executable, ...command.args]
    .map((part) => JSON.stringify(part))
    .join(" ");
}

function sanitizeCapture(
  capture: CapturedOutput,
  secrets: string[],
): CapturedOutput {
  return { ...capture, text: redact(capture.text, secrets) };
}

export class BoundedExperimentExecutor {
  async executeRun(input: {
    command: SandboxCommand;
    environment: ExecutionEnvironmentProvenance;
    networkPolicy: "deny-all";
    runId: string;
    secrets: string[];
    session: IsolatedSandboxSession;
    signal?: AbortSignal;
  }): Promise<BoundedRun> {
    if (
      input.networkPolicy !== "deny-all" ||
      input.environment.networkPolicy !== "deny-all" ||
      input.signal?.aborted
    ) {
      throw new ExecutionLimitError("PROVIDER_INTERRUPTED");
    }
    const command = sandboxCommandSchema.parse(input.command);
    if (command.phase !== "control" && command.phase !== "candidate") {
      throw new ExecutionLimitError("PROVIDER_INTERRUPTED");
    }
    const id = z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
      .parse(input.runId);
    await input.session.makeDirectory(SUPERVISOR_DIRECTORY);
    const configPath = `${SUPERVISOR_DIRECTORY}/${id}.config.json`;
    const resultPath = `${SUPERVISOR_DIRECTORY}/${id}.result.json`;
    const workspaceRoot = command.cwd.split("/").slice(0, 5).join("/");
    const config = {
      args: command.args,
      cwd: command.cwd,
      executable: command.executable,
      limits: {
        commandTimeoutMs: EXECUTION_LIMITS.commandTimeoutMs,
        maxMemoryBytes: EXECUTION_LIMITS.maxMemoryBytes,
        maxOutputBytes: EXECUTION_LIMITS.maxOutputBytes,
        maxProcesses: EXECUTION_LIMITS.maxProcesses,
        maxWorkspaceBytes: EXECUTION_LIMITS.maxWorkspaceBytes,
      },
      phase: command.phase,
      workspaceRoot,
    };
    await input.session.writeFiles([
      {
        content: new TextEncoder().encode(RUNNER_SUPERVISOR_SOURCE),
        path: SUPERVISOR_PATH,
      },
      {
        content: new TextEncoder().encode(JSON.stringify(config)),
        path: configPath,
      },
    ]);
    let launched;
    try {
      launched = await input.session.run(
        sandboxCommandSchema.parse({
          args: [SUPERVISOR_PATH, configPath, resultPath],
          cwd: command.cwd,
          executable: "node",
          phase: command.phase,
          timeoutMs: 125_000,
        }),
        { signal: input.signal },
      );
    } catch {
      throw new ExecutionLimitError("PROVIDER_INTERRUPTED");
    }
    if (launched.exitCode !== 0) {
      throw new ExecutionLimitError("PROVIDER_INTERRUPTED");
    }
    const rawResult = await input.session.readFile(resultPath);
    if (
      !rawResult ||
      rawResult.byteLength > EXECUTION_LIMITS.maxOutputBytes + 64 * 1024
    ) {
      throw new ExecutionLimitError("OUTPUT_INVALID");
    }
    let result: SupervisorResult;
    try {
      result = supervisorResultSchema.parse(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawResult)),
      );
    } catch {
      throw new ExecutionLimitError("OUTPUT_INVALID");
    }
    if (result.termination !== null) mapTermination(result.termination);
    const stdout = sanitizeCapture(result.stdout, input.secrets);
    const stderr = sanitizeCapture(result.stderr, input.secrets);
    const role = command.phase === "control" ? "control" : "candidate";
    const run = runResultSchema.parse({
      command: displayCommand(command),
      durationMs: result.durationMs,
      environmentHash: input.environment.environmentHash,
      exitCode: result.exitCode,
      id,
      stderr: stderr.text,
      stdout: stdout.text,
    });
    return boundedRunSchema.parse({
      capture: { stderr, stdout },
      role,
      run,
    });
  }

  async execute(input: {
    environment: ExecutionEnvironmentProvenance;
    networkPolicy: "deny-all";
    plan: RepositoryExecutionPlan;
    secrets: string[];
    session: IsolatedSandboxSession;
    signal?: AbortSignal;
  }): Promise<BoundedExperimentResult> {
    if (
      input.networkPolicy !== "deny-all" ||
      input.environment.networkPolicy !== "deny-all"
    ) {
      throw new ExecutionLimitError("PROVIDER_INTERRUPTED");
    }
    const plan = repositoryExecutionPlanSchema.parse(input.plan);
    const experimentCommands = plan.commands.filter(
      (command) => command.phase === "control" || command.phase === "candidate",
    );
    if (
      experimentCommands.length > EXECUTION_LIMITS.maxRuns + 1 ||
      plan.commands.length > EXECUTION_LIMITS.maxToolCalls
    ) {
      throw new ExecutionLimitError("PROVIDER_INTERRUPTED");
    }
    const runs: BoundedRun[] = [];
    let totalDurationMs = 0;
    for (const [index, command] of experimentCommands.entries()) {
      const id = command.phase === "control" ? "control-1" : `candidate-${index}`;
      const run = await this.executeRun({
        command,
        environment: input.environment,
        networkPolicy: input.networkPolicy,
        runId: id,
        secrets: input.secrets,
        session: input.session,
        signal: input.signal,
      });
      totalDurationMs += run.run.durationMs;
      if (totalDurationMs > EXECUTION_LIMITS.maxTotalAttemptMs) {
        throw new ExecutionLimitError("ATTEMPT_TIMEOUT");
      }
      runs.push(run);
    }
    const control = runs.find((run) => run.role === "control");
    const candidates = runs.filter((run) => run.role === "candidate");
    if (!control || candidates.length !== plan.requiredRuns) {
      throw new ExecutionLimitError("PROVIDER_INTERRUPTED");
    }
    return boundedExperimentResultSchema.parse({
      candidates,
      control,
      limitsPolicyVersion: EXECUTION_LIMITS.policyVersion,
      totalDurationMs,
    });
  }
}
