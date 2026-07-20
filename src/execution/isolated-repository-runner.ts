import { z } from "zod";

import type {
  RepositoryArchiveCredentialProvider,
  RepositoryPrincipal,
} from "@/application/ports/repository-source";
import { reproCaseSchema } from "@/domain/case";
import { failureOracleSchema } from "@/domain/oracle";
import {
  boundedExperimentResultSchema,
  BoundedExperimentExecutor,
  EXECUTION_LIMITS,
  type BoundedRun,
} from "@/execution/bounded-execution";
import {
  immutableRepositorySourceSchema,
  nodeRepositoryProfileSchema,
  type IsolatedSandboxProvider,
  type IsolatedSandboxSession,
} from "@/execution/contracts";
import {
  dependencyMetadataSchema,
  NodeDependencyPreparer,
  type PreparedDependencies,
} from "@/execution/dependency-preparation";
import {
  buildNodeExecutionPlan,
  collectExecutionEnvironment,
  prepareExperimentWorkspaces,
  type ExecutionEnvironmentProvenance,
} from "@/execution/execution-planning";
import {
  GitHubArchiveAcquirer,
  type AcquiredRepositorySource,
} from "@/execution/github-source-acquisition";
import {
  assembleRepositoryProof,
  type RepositoryProofResult,
} from "@/execution/repository-proof";
import {
  AttemptLifecycleError,
  SnapshotRunCoordinator,
  type SandboxQuarantineSink,
} from "@/execution/sandbox-lifecycle";

const principalSchema = z
  .object({
    callerId: z.string().min(1).max(128),
    principalId: z.string().min(1).max(128),
    tenantId: z.string().min(1).max(128),
  })
  .strict();

const runnerInputSchema = z
  .object({
    attemptId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
    budget: z
      .object({
        maxToolCalls: z.number().int().min(1).max(EXECUTION_LIMITS.maxToolCalls),
        requiredRuns: z.number().int().min(3).max(EXECUTION_LIMITS.maxRuns),
      })
      .strict(),
    case: reproCaseSchema.refine((value) => value.state === "DRAFT"),
    issueEvidence: z
      .object({
        number: z.number().int().positive().max(2_147_483_647),
        title: z.string().min(1).max(256).optional(),
      })
      .strict()
      .optional(),
    oracle: failureOracleSchema,
    principal: principalSchema,
    profile: nodeRepositoryProfileSchema,
    secrets: z.array(z.string().min(1).max(4_096)).max(8).default([]),
    source: immutableRepositorySourceSchema,
  })
  .strict();

type RunnerInput = z.input<typeof runnerInputSchema> & {
  signal?: AbortSignal;
};

type Acquire = (input: {
  principal: RepositoryPrincipal;
  session: IsolatedSandboxSession;
  source: z.infer<typeof immutableRepositorySourceSchema>;
}) => Promise<AcquiredRepositorySource>;

type PrepareDependencies = (input: {
  manifest: AcquiredRepositorySource["manifest"];
  profile: z.infer<typeof nodeRepositoryProfileSchema>;
  session: IsolatedSandboxSession;
  sourceWorkspace: string;
}) => Promise<PreparedDependencies>;

type Dependencies = {
  acquire?: Acquire;
  attemptTimeoutMs?: number;
  clock?: { now(): Date };
  collectEnvironment?: typeof collectExecutionEnvironment;
  credentialProvider?: RepositoryArchiveCredentialProvider;
  executeRun?: BoundedExperimentExecutor["executeRun"];
  plan?: typeof buildNodeExecutionPlan;
  prepareDependencies?: PrepareDependencies;
  prepareWorkspaces?: typeof prepareExperimentWorkspaces;
  provider: IsolatedSandboxProvider;
  quarantine: SandboxQuarantineSink;
};

export type RepositoryExecutionCode =
  | "ATTEMPT_TIMEOUT"
  | "CANCELLED"
  | "EXECUTION_FAILED"
  | "PROVIDER_INTERRUPTED"
  | "UNSUPPORTED_SOURCE";

export type RepositoryExecutionStage =
  | "acquisition"
  | "dependencies"
  | "environment"
  | "experiments"
  | "proof"
  | "provisioning"
  | "workspaces";

export class RepositoryExecutionError extends Error {
  constructor(
    readonly code: RepositoryExecutionCode,
    readonly stage: RepositoryExecutionStage = "provisioning",
  ) {
    super("The isolated repository attempt did not complete safely");
    this.name = "RepositoryExecutionError";
  }
}

export class IsolatedRepositoryRunner {
  private readonly acquire: Acquire;
  private readonly attemptTimeoutMs: number;
  private readonly clock: { now(): Date };
  private readonly collectEnvironment: typeof collectExecutionEnvironment;
  private readonly executeRun: BoundedExperimentExecutor["executeRun"];
  private readonly plan: typeof buildNodeExecutionPlan;
  private readonly prepareDependencies: PrepareDependencies;
  private readonly prepareWorkspaces: typeof prepareExperimentWorkspaces;

  constructor(private readonly dependencies: Dependencies) {
    this.attemptTimeoutMs = z
      .number()
      .int()
      .min(1)
      .max(EXECUTION_LIMITS.maxTotalAttemptMs)
      .parse(dependencies.attemptTimeoutMs ?? EXECUTION_LIMITS.maxTotalAttemptMs);
    this.clock = dependencies.clock ?? { now: () => new Date() };
    if (dependencies.acquire) {
      this.acquire = dependencies.acquire;
    } else if (dependencies.credentialProvider) {
      const acquirer = new GitHubArchiveAcquirer({
        clock: this.clock,
        credentialProvider: dependencies.credentialProvider,
      });
      this.acquire = (input) => acquirer.acquire(input);
    } else {
      throw new RepositoryExecutionError("EXECUTION_FAILED");
    }
    const dependencyPreparer = new NodeDependencyPreparer();
    const experimentExecutor = new BoundedExperimentExecutor();
    this.collectEnvironment =
      dependencies.collectEnvironment ?? collectExecutionEnvironment;
    this.executeRun =
      dependencies.executeRun ??
      ((input) => experimentExecutor.executeRun(input));
    this.plan = dependencies.plan ?? buildNodeExecutionPlan;
    this.prepareDependencies =
      dependencies.prepareDependencies ??
      ((input) => dependencyPreparer.prepare(input));
    this.prepareWorkspaces =
      dependencies.prepareWorkspaces ?? prepareExperimentWorkspaces;
  }

  async execute(rawInput: RunnerInput): Promise<RepositoryProofResult> {
    const { signal, ...candidate } = rawInput;
    const input = runnerInputSchema.parse(candidate);
    const quarantine: SandboxQuarantineSink = {
      record: (record) =>
        this.dependencies.quarantine.record({
          ...record,
          actorId: input.principal.principalId,
          tenantId: input.principal.tenantId,
        }),
    };
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.attemptTimeoutMs);
    const cancel = () => controller.abort();
    if (signal?.aborted) cancel();
    signal?.addEventListener("abort", cancel, { once: true });

    let prepared: IsolatedSandboxSession | undefined;
    let stage: RepositoryExecutionStage = "provisioning";
    let lifecycleOwnsPrepared = false;
    let stopPrepared: Promise<void> | undefined;
    const cleanupPrepared = async () => {
      if (!prepared) return;
      stopPrepared ??= prepared.stop();
      try {
        await stopPrepared;
      } catch {
        try {
          await quarantine.record({
            attemptId: input.attemptId,
            providerResourceId: prepared.sandboxId,
            reason: "cleanup-failed",
            resourceType: "sandbox",
          });
        } catch {
          // Cleanup remains quarantined even when alert delivery fails.
        }
      }
    };
    const stopOnAbort = () => {
      void cleanupPrepared();
    };

    try {
      if (controller.signal.aborted) {
        throw new RepositoryExecutionError(
          timedOut ? "ATTEMPT_TIMEOUT" : "CANCELLED",
        );
      }
      prepared = await this.dependencies.provider.create(
        {
          networkPolicy: "deny-all",
          runtime: `node${input.profile.nodeVersion}`,
          timeoutMs: Math.min(180_000, this.attemptTimeoutMs),
          vcpus: 2,
        },
        { signal: controller.signal },
      );
      controller.signal.addEventListener("abort", stopOnAbort, { once: true });
      stage = "acquisition";
      const acquired = await this.acquire({
        principal: input.principal,
        session: prepared,
        source: input.source,
      });
      stage = "dependencies";
      const dependency = await this.prepareDependencies({
        manifest: acquired.manifest,
        profile: input.profile,
        session: prepared,
        sourceWorkspace: acquired.workspacePath,
      });
      const plan = this.plan({
        profile: input.profile,
        requiredRuns: input.budget.requiredRuns,
        source: input.source,
      });
      stage = "workspaces";
      await this.prepareWorkspaces({
        networkPolicy: "deny-all",
        plan,
        session: prepared,
        sourceWorkspace: acquired.workspacePath,
      });
      stage = "environment";
      const environment = await this.collectEnvironment({
        dependency,
        networkPolicy: "deny-all",
        profile: input.profile,
        session: prepared,
        source: acquired.provenance,
      });
      const dependencyMetadata = dependencyMetadataSchema.parse({
        dependencyCount: dependency.dependencyCount,
        lockfileSha256: dependency.lockfileSha256,
        lockfileVersion: dependency.lockfileVersion,
        packageJsonSha256: dependency.packageJsonSha256,
        policyVersion: dependency.policyVersion,
      });
      const experimentCommands = plan.commands.filter(
        (command) =>
          command.phase === "control" || command.phase === "candidate",
      );
      controller.signal.removeEventListener("abort", stopOnAbort);
      lifecycleOwnsPrepared = true;
      const remaining = Math.max(
        1,
        this.attemptTimeoutMs -
          Math.max(
            0,
            this.clock.now().getTime() - Date.parse(input.case.createdAt),
          ),
      );
      const coordinator = new SnapshotRunCoordinator({
        attemptTimeoutMs: remaining,
        provider: this.dependencies.provider,
        quarantine,
      });
      stage = "experiments";
      const lifecycle = await coordinator.execute({
        attemptId: input.attemptId,
        preparedSession: prepared,
        run: async ({ index, session, signal: runSignal }) => {
          const command = experimentCommands[index];
          if (!command) throw new RepositoryExecutionError("EXECUTION_FAILED");
          return this.executeRun({
            command,
            environment,
            networkPolicy: "deny-all",
            runId:
              command.phase === "control"
                ? "control-1"
                : `candidate-${index}`,
            secrets: input.secrets,
            session,
            signal: runSignal,
          });
        },
        runCount: experimentCommands.length,
        signal: controller.signal,
      });
      const execution = this.executionResult(lifecycle.values, environment);
      stage = "proof";
      return await assembleRepositoryProof({
        budget: input.budget,
        case: input.case,
        cleanupStatus: lifecycle.cleanupStatus,
        dependency: dependencyMetadata,
        environment,
        execution,
        generatedAt: this.clock.now().toISOString(),
        issueEvidence: input.issueEvidence,
        oracle: input.oracle,
        profile: input.profile,
        secrets: input.secrets,
        source: input.source,
        sourceProvenance: acquired.provenance,
      });
    } catch (error) {
      if (error instanceof RepositoryExecutionError) throw error;
      if (controller.signal.aborted) {
        throw new RepositoryExecutionError(
          timedOut ? "ATTEMPT_TIMEOUT" : "CANCELLED",
        );
      }
      if (error instanceof AttemptLifecycleError) {
        throw new RepositoryExecutionError(
          error.code === "ATTEMPT_TIMEOUT"
            ? "ATTEMPT_TIMEOUT"
            : error.code === "CANCELLED"
              ? "CANCELLED"
              : error.code === "PROVIDER_INTERRUPTED"
                ? "PROVIDER_INTERRUPTED"
                : "EXECUTION_FAILED",
        );
      }
      const code =
        error && typeof error === "object" && "code" in error
          ? String(error.code)
          : "";
      if (
        code === "UNSUPPORTED_SOURCE" ||
        code === "UNSAFE_ARCHIVE" ||
        code === "ARCHIVE_LIMIT_EXCEEDED"
      ) {
        throw new RepositoryExecutionError("UNSUPPORTED_SOURCE");
      }
      throw new RepositoryExecutionError("EXECUTION_FAILED", stage);
    } finally {
      controller.signal.removeEventListener("abort", stopOnAbort);
      signal?.removeEventListener("abort", cancel);
      clearTimeout(timeout);
      if (!lifecycleOwnsPrepared) await cleanupPrepared();
    }
  }

  private executionResult(
    values: BoundedRun[],
    environment: ExecutionEnvironmentProvenance,
  ) {
    const control = values.find((value) => value.role === "control");
    const candidates = values.filter((value) => value.role === "candidate");
    if (!control || values.some((value) => value.run.environmentHash !== environment.environmentHash)) {
      throw new RepositoryExecutionError("EXECUTION_FAILED");
    }
    return boundedExperimentResultSchema.parse({
      candidates,
      control,
      limitsPolicyVersion: EXECUTION_LIMITS.policyVersion,
      totalDurationMs: values.reduce(
        (total, value) => total + value.run.durationMs,
        0,
      ),
    });
  }
}
