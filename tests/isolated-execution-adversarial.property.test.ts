import { createHash } from "node:crypto";

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { DurableQueueConsumer } from "@/application/durable-queue-consumer";
import type {
  DurableReproductionRecord,
  DurableReproductionRepository,
  JobLease,
} from "@/application/ports/production";
import { createCase, transitionCase } from "@/domain/case";
import type { FailureOracle } from "@/domain/oracle";
import { transitionJob } from "@/domain/job";
import {
  captureBoundedOutput,
  type BoundedExperimentResult,
} from "@/execution/bounded-execution";
import type {
  IsolatedSandboxSession,
  NodeRepositoryProfile,
  SandboxCommand,
  SandboxNetworkPolicy,
} from "@/execution/contracts";
import {
  NodeDependencyPreparer,
  validateNodeDependencyMetadata,
} from "@/execution/dependency-preparation";
import {
  buildNodeExecutionPlan,
  type ExecutionEnvironmentProvenance,
} from "@/execution/execution-planning";
import {
  assembleRepositoryProof,
  RepositoryProofInputError,
  type RepositoryProofInput,
} from "@/execution/repository-proof";
import {
  SourceValidationError,
  validateArchiveManifest,
  type ArchiveManifest,
  type SourceProvenance,
} from "@/execution/source-provenance";

import {
  DURABLE_AT,
  durableRecord,
  queueMessage,
} from "./helpers/durable-postgres-fixture";

const encoder = new TextEncoder();
const safeSegment = fc.stringMatching(/^[A-Za-z0-9_-]{1,16}$/);
const scriptName = fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9:._/-]{0,31}$/);
const hexCommit = fc
  .array(fc.constantFrom(..."abcdef0123456789"), {
    minLength: 40,
    maxLength: 40,
  })
  .map((characters) => characters.join(""));
const secretSuffix = fc.stringMatching(/^[A-Za-z0-9_-]{8,24}$/);

const oracle: FailureOracle = {
  id: "oracle-adversarial-exit",
  root: {
    children: [
      { expected: 1, type: "exit_code" },
      {
        stream: "stderr",
        type: "output_contains",
        value: "synthetic failure",
      },
    ],
    type: "all",
  },
  version: 1,
};

describe("isolated execution adversarial properties", () => {
  it(
    "keeps normalized paths, commands, secrets, output, proof, and bundles invariant",
    async () => {
      await fc.assert(
        fc.asyncProperty(
        fc.array(safeSegment, { minLength: 1, maxLength: 4 }),
        scriptName,
        scriptName,
        hexCommit,
        secretSuffix,
        fc.uint8Array({ maxLength: 1_024 }),
        fc.integer({ min: 0, max: 512 }),
        fc
          .string({ minLength: 1, maxLength: 128 })
          .filter((value) => !value.includes("\u0000")),
        fc.jsonValue(),
        async (
          pathSegments,
          controlScript,
          reproductionScript,
          commitSha,
          suffix,
          bytes,
          maxBytes,
          scriptBody,
          arbitraryMetadata,
        ) => {
          const root = "repository-root";
          const manifest = validateArchiveManifest({
            archiveBytes: 2_048,
            archiveSha256: "a".repeat(64),
            entries: [
              { path: root, size: 0, type: "directory" },
              {
                path: `${root}/${pathSegments.join("/")}.js`,
                size: bytes.byteLength,
                type: "file",
              },
            ],
          });
          expect(manifest.files).toHaveLength(1);
          for (const file of manifest.files) {
            expect(file.path.startsWith("/")).toBe(false);
            expect(file.path.includes("\\")).toBe(false);
            expect(file.path.split("/")).not.toContain("..");
          }

          const profile: NodeRepositoryProfile = {
            controlScript,
            ecosystem: "node",
            lockfile: "package-lock.json",
            nodeVersion: "24",
            packageManager: "npm",
            reproductionScript,
          };
          const packageBytes = encoder.encode(
            JSON.stringify({
              generatedMetadata: arbitraryMetadata,
              packageManager: "npm@11.4.2",
              scripts: {
                [controlScript]: `${scriptBody} control`,
                [reproductionScript]: `${scriptBody} reproduce`,
              },
            }),
          );
          expect(() =>
            validateNodeDependencyMetadata({
              lockBytes: validLockBytes(),
              manifest: dependencyManifest,
              packageBytes,
              profile,
            }),
          ).not.toThrow();
          const source = immutableSource(commitSha);
          const plan = buildNodeExecutionPlan({
            profile,
            requiredRuns: 3,
            source,
          });
          expect(plan.commands.map((command) => command.phase)).toEqual([
            "dependency-acquisition",
            "offline-install",
            "control",
            "candidate",
            "candidate",
            "candidate",
          ]);
          for (const command of plan.commands) {
            expect(command.executable).toMatch(/^(?:cp|npm)$/);
            expect(command.cwd).toMatch(/^\/vercel\/sandbox\/workspaces\//);
          }
          expect(plan.commands.find((command) => command.phase === "control")?.args).toEqual([
            "run",
            controlScript,
          ]);
          for (const command of plan.commands.filter(
            (candidate) => candidate.phase === "candidate",
          )) {
            expect(command.args).toEqual(["run", reproductionScript]);
          }

          const firstCapture = captureBoundedOutput(bytes, maxBytes, []);
          const secondCapture = captureBoundedOutput(bytes, maxBytes, []);
          expect(secondCapture).toEqual(firstCapture);
          expect(firstCapture).toMatchObject({
            originalBytes: bytes.byteLength,
            sha256: createHash("sha256").update(bytes).digest("hex"),
            truncated: bytes.byteLength > maxBytes,
          });

          const secret = `SYNTHETIC_SECRET_${suffix}`;
          const secretCapture = captureBoundedOutput(
            encoder.encode(`before ${secret} after`),
            4_096,
            [secret],
          );
          expect(secretCapture.text).not.toContain(secret);

          const proofInput = repositoryProofInput({
            commitSha,
            controlScript,
            reproductionScript,
            secret,
          });
          const firstProof = await assembleRepositoryProof(proofInput);
          const secondProof = await assembleRepositoryProof(proofInput);
          expect(firstProof.bundle?.bundleHash).toBe(
            secondProof.bundle?.bundleHash,
          );
          expect(firstProof.files).toEqual(secondProof.files);
          expect(JSON.stringify(firstProof)).not.toContain(secret);
          await expect(
            assembleRepositoryProof({
              ...proofInput,
              providerClaimedStatus: "VERIFIED",
            } as never),
          ).rejects.toBeInstanceOf(RepositoryProofInputError);
        },
        ),
        { numRuns: 500 },
      );
    },
    30_000,
  );

  it("rejects every generated escape and special archive entry", () => {
    const unsafePath = safeSegment.chain((name) =>
      fc.constantFrom(
        `../${name}`,
        `/repository-root/${name}`,
        `repository-root/../${name}`,
        `repository-root/./${name}`,
        `repository-root//${name}`,
        `repository-root\\${name}`,
        `C:\\repository-root\\${name}`,
        `repository-root/${name}\u0000suffix`,
      ),
    );
    const unsafeEntry = fc.oneof(
      unsafePath.map((path) => ({ path, type: "file" as const })),
      fc
        .constantFrom(
          "symlink" as const,
          "hardlink" as const,
          "device" as const,
          "fifo" as const,
          "socket" as const,
        )
        .map((type) => ({ path: "repository-root/unsafe", type })),
    );

    fc.assert(
      fc.property(unsafeEntry, ({ path, type }) => {
        expect(() =>
          validateArchiveManifest({
            archiveBytes: 1_024,
            archiveSha256: "a".repeat(64),
            entries: [
              { path: "repository-root", size: 0, type: "directory" },
              { path, size: 1, type },
            ],
          }),
        ).toThrow(SourceValidationError);
      }),
      { numRuns: 500 },
    );
  });

  it("never runs repository-controlled work before deny-all is restored", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(
          "none" as const,
          "acquisition" as const,
          "lockdown" as const,
          "offline" as const,
        ),
        scriptName,
        scriptName,
        async (failure, controlScript, reproductionScript) => {
          const profile: NodeRepositoryProfile = {
            controlScript,
            ecosystem: "node",
            lockfile: "package-lock.json",
            nodeVersion: "24",
            packageManager: "npm",
            reproductionScript,
          };
          const { events, session } = dependencySession(profile, failure);
          const preparation = new NodeDependencyPreparer().prepare({
            manifest: dependencyManifest,
            profile,
            session,
            sourceWorkspace: "/vercel/sandbox/workspaces/source",
          });
          if (failure === "none") await expect(preparation).resolves.toBeDefined();
          else await expect(preparation).rejects.toBeDefined();

          for (const event of events.filter(
            (candidate) => candidate.kind === "run",
          )) {
            if (event.command.phase === "dependency-acquisition") {
              if (event.command.executable === "npm") {
                expect(event.command.args).toContain("--ignore-scripts");
              }
              continue;
            }
            expect(event.policy).toBe("deny-all");
          }
          const offline = events.find(
            (event) =>
              event.kind === "run" && event.command.phase === "offline-install",
          );
          const denied = events.findIndex(
            (event) => event.kind === "policy" && event.policy === "deny-all",
          );
          if (offline) {
            expect(denied).toBeGreaterThanOrEqual(0);
            expect(events.indexOf(offline)).toBeGreaterThan(denied);
          }
        },
      ),
      { numRuns: 500 },
    );
  });

  it("reduces duplicate, cancellation, and worker-failure sequences to one terminal decision", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 12 }),
        fc.constantFrom(
          "complete" as const,
          "cancel-before" as const,
          "cancel-during" as const,
          "worker-failure" as const,
        ),
        async (deliveryCount, mode) => {
          const fixture = inMemoryDeliveryFixture(mode);
          const consumer = new DurableQueueConsumer({
            clock: { now: () => new Date(DURABLE_AT) },
            leaseSeconds: 60,
            repository: fixture.repository,
            worker: fixture.worker,
          });
          await Promise.all(
            Array.from({ length: deliveryCount }, (_, index) =>
              consumer.consume(
                queueMessage(
                  fixture.record,
                  index % 2 === 0
                    ? "reproduction.requested"
                    : "reproduction.recovery-requested",
                  `adversarial_${index}_${fixture.record.caseId}`,
                ),
                `worker_adversarial_${index}`,
              ),
            ),
          );

          expect(fixture.terminalWrites()).toBe(1);
          expect(fixture.executions()).toBe(mode === "cancel-before" ? 0 : 1);
          expect(fixture.cleanupDecisions()).toBe(fixture.executions());
          expect(fixture.current().snapshot.job.state).toMatch(
            /^(?:CANCELLED|FAILED)$/,
          );
        },
      ),
      { numRuns: 500 },
    );
  });
});

function immutableSource(commitSha: string) {
  return {
    commitSha,
    fullName: "acme/adversarial-repository",
    private: true,
    provider: "github" as const,
    repositoryId: "repo_adversarial",
  };
}

function repositoryProofInput(input: {
  commitSha: string;
  controlScript: string;
  reproductionScript: string;
  secret: string;
}): RepositoryProofInput {
  const source = immutableSource(input.commitSha);
  const sourceProvenance: SourceProvenance = {
    acquiredAt: "2026-07-21T18:00:00.000Z",
    archiveBytes: 4_096,
    archiveSha256: "b".repeat(64),
    commitSha: source.commitSha,
    extractedBytes: 8_192,
    fileCount: 8,
    manifestSha256: "c".repeat(64),
    policyVersion: "source-archive-v1",
    provider: "github",
    repositoryId: source.repositoryId,
    schemaVersion: "1.0",
  };
  const dependency = {
    dependencyCount: 12,
    lockfileSha256: "d".repeat(64),
    lockfileVersion: 3 as const,
    packageJsonSha256: "e".repeat(64),
    policyVersion: "node-lock-v1" as const,
  };
  const environment: ExecutionEnvironmentProvenance = {
    archiveSha256: sourceProvenance.archiveSha256,
    dependencyPolicyVersion: dependency.policyVersion,
    environmentHash: "f".repeat(64),
    executionPolicyVersion: "node-npm-v1",
    lockfileSha256: dependency.lockfileSha256,
    manifestSha256: sourceProvenance.manifestSha256,
    networkPolicy: "deny-all",
    nodeVersion: "24.8.0",
    npmVersion: "11.4.2",
    packageJsonSha256: dependency.packageJsonSha256,
    provider: "vercel-sandbox",
    runtime: "node24",
    schemaVersion: "1.0",
    sourceCommitSha: source.commitSha,
    sourcePolicyVersion: sourceProvenance.policyVersion,
    vcpus: 2,
  };
  const profile: NodeRepositoryProfile = {
    controlScript: input.controlScript,
    ecosystem: "node",
    lockfile: "package-lock.json",
    nodeVersion: "24",
    packageManager: "npm",
    reproductionScript: input.reproductionScript,
  };
  const candidates = [1, 2, 3].map((index) =>
    boundedRun(
      `candidate-${index}`,
      1,
      `synthetic failure ${input.secret}`,
      environment.environmentHash,
      [input.secret],
    ),
  );
  return {
    budget: { maxToolCalls: 6, requiredRuns: 3 },
    case: createCase(
      `case_${input.commitSha.slice(0, 32)}`,
      new Date("2026-07-21T18:00:00.000Z"),
    ),
    cleanupStatus: "clean",
    dependency,
    environment,
    execution: {
      candidates,
      control: boundedRun(
        "control-1",
        0,
        "",
        environment.environmentHash,
        [input.secret],
      ),
      limitsPolicyVersion: "sandbox-limits-v1",
      totalDurationMs: 40,
    } satisfies BoundedExperimentResult,
    generatedAt: "2026-07-21T18:00:20.000Z",
    issueEvidence: {
      number: 42,
      title: `Reported failure ${input.secret}`,
    },
    oracle,
    profile,
    secrets: [input.secret],
    source,
    sourceProvenance,
  };
}

function boundedRun(
  id: string,
  exitCode: number,
  stderr: string,
  environmentHash: string,
  secrets: string[],
) {
  return {
    capture: {
      stderr: captureBoundedOutput(encoder.encode(stderr), 2_048, secrets),
      stdout: captureBoundedOutput(new Uint8Array(), 2_048, secrets),
    },
    role: id.startsWith("control") ? ("control" as const) : ("candidate" as const),
    run: {
      command: id.startsWith("control")
        ? 'npm "run" "test:control"'
        : 'npm "run" "test:repro"',
      durationMs: 10,
      environmentHash,
      exitCode,
      id,
      stderr,
      stdout: "",
    },
  };
}

const dependencyManifest: ArchiveManifest = {
  archiveBytes: 2_048,
  archiveSha256: "a".repeat(64),
  extractedBytes: 1_024,
  fileCount: 2,
  files: [
    { path: "package-lock.json", size: 512 },
    { path: "package.json", size: 512 },
  ],
  rootDirectory: "repository-root",
};

type DependencyEvent =
  | { kind: "policy"; policy: SandboxNetworkPolicy["kind"] }
  | {
      command: SandboxCommand;
      kind: "run";
      policy: SandboxNetworkPolicy["kind"];
    };

function dependencySession(
  profile: NodeRepositoryProfile,
  failure: "none" | "acquisition" | "lockdown" | "offline",
): { events: DependencyEvent[]; session: IsolatedSandboxSession } {
  const events: DependencyEvent[] = [];
  let policy: SandboxNetworkPolicy["kind"] = "deny-all";
  const packageBytes = encoder.encode(
    JSON.stringify({
      packageManager: "npm@11.4.2",
      scripts: {
        [profile.controlScript]: "node control.mjs",
        [profile.reproductionScript]: "node reproduce.mjs",
      },
    }),
  );
  const lockBytes = validLockBytes();
  const success = {
    durationMs: 1,
    exitCode: 0,
    stderr: new Uint8Array(),
    stdout: new Uint8Array(),
  };
  const session: IsolatedSandboxSession = {
    sandboxId: "sandbox_dependency_property",
    makeDirectory: async () => undefined,
    readFile: async (path) =>
      path.endsWith("package-lock.json") ? lockBytes : packageBytes,
    run: async (command) => {
      events.push({ command, kind: "run", policy });
      const shouldFail =
        (failure === "acquisition" &&
          command.phase === "dependency-acquisition" &&
          command.executable === "npm") ||
        (failure === "offline" && command.phase === "offline-install");
      return shouldFail ? { ...success, exitCode: 1 } : success;
    },
    setNetworkPolicy: async (next) => {
      events.push({ kind: "policy", policy: next.kind });
      if (failure === "lockdown" && next.kind === "deny-all") {
        throw new Error("synthetic lockdown failure");
      }
      policy = next.kind;
    },
    snapshot: async () => ({
      delete: async () => undefined,
      snapshotId: "snapshot_dependency_property",
    }),
    stop: async () => undefined,
    usage: async () => ({
      activeCpuMs: 0,
      networkEgressBytes: 0,
      networkIngressBytes: 0,
    }),
    writeFiles: async () => undefined,
  };
  return { events, session };
}

function validLockBytes(): Uint8Array {
  return encoder.encode(
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": {},
        "node_modules/synthetic": {
          integrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}`,
          resolved:
            "https://registry.npmjs.org/synthetic/-/synthetic-1.0.0.tgz",
        },
      },
    }),
  );
}

function inMemoryDeliveryFixture(
  mode: "complete" | "cancel-before" | "cancel-during" | "worker-failure",
) {
  let record = durableRecord(
    `tenant_adversarial_${mode.replaceAll("-", "_")}`,
    `delivery_${mode.replaceAll("-", "_")}`,
  );
  let claimed = false;
  let cancelRequested = mode === "cancel-before";
  let executionCount = 0;
  let cleanupCount = 0;
  let terminalCount = 0;
  let lease: JobLease | null = null;

  const cancel = () => {
    const at = new Date("2026-07-19T20:00:02.000Z");
    record = {
      ...record,
      snapshot: {
        ...record.snapshot,
        case: transitionCase(
          record.snapshot.case,
          "CANCELLED",
          "generated cancellation",
          at,
        ),
        job: transitionJob(record.snapshot.job, "CANCELLED", {
          at,
          progressPhase: "CANCELLED",
        }),
      },
      updatedAt: at.toISOString(),
    };
    terminalCount += 1;
    return record;
  };
  const fail = () => {
    const startedAt = new Date("2026-07-19T20:00:01.000Z");
    const failedAt = new Date("2026-07-19T20:00:02.000Z");
    const ingesting =
      record.snapshot.case.state === "DRAFT"
        ? transitionCase(
            record.snapshot.case,
            "INGESTING",
            "generated execution",
            startedAt,
          )
        : record.snapshot.case;
    record = {
      ...record,
      snapshot: {
        ...record.snapshot,
        case: transitionCase(
          ingesting,
          "BLOCKED",
          "generated terminal failure",
          failedAt,
        ),
        job: transitionJob(record.snapshot.job, "FAILED", {
          at: failedAt,
          failure: {
            code: "GENERATED_TERMINAL",
            message: "The generated worker stopped safely",
            retryable: false,
          },
          progressPhase: "BLOCKED",
        }),
      },
      updatedAt: failedAt.toISOString(),
    };
    terminalCount += 1;
    return record;
  };

  const repository = {
    cancelLease: async () => cancel(),
    claimLease: async (input: {
      at: string;
      jobId: string;
      leaseSeconds: number;
      ownerId: string;
      tenantId: string;
    }) => {
      if (claimed || record.snapshot.job.state !== "QUEUED") return null;
      claimed = true;
      const at = new Date(input.at);
      record = {
        ...record,
        snapshot: {
          ...record.snapshot,
          job: transitionJob(record.snapshot.job, "RUNNING", {
            at,
            progressPhase: "INGESTING",
          }),
        },
      };
      lease = {
        acquiredAt: at.toISOString(),
        attempt: 1,
        expiresAt: new Date(
          at.getTime() + input.leaseSeconds * 1_000,
        ).toISOString(),
        jobId: input.jobId,
        ownerId: input.ownerId,
        tenantId: input.tenantId,
      };
      return lease;
    },
    completeLease: async (_lease: JobLease, completed: DurableReproductionRecord) => {
      record = completed;
      terminalCount += 1;
      return record;
    },
    failLease: async () => {
      fail();
      return "exhausted" as const;
    },
    findByLease: async (candidate: JobLease) =>
      lease?.ownerId === candidate.ownerId ? record : null,
    isCancellationRequested: async () => cancelRequested,
  } as unknown as DurableReproductionRepository;

  return {
    cleanupDecisions: () => cleanupCount,
    current: () => record,
    executions: () => executionCount,
    record,
    repository,
    terminalWrites: () => terminalCount,
    worker: {
      execute: async ({ record: active }: { record: DurableReproductionRecord }) => {
        executionCount += 1;
        try {
          if (mode === "cancel-during") cancelRequested = true;
          if (mode === "worker-failure") {
            throw new Error("synthetic worker timeout");
          }
          const at = new Date("2026-07-19T20:00:02.000Z");
          const ingesting = transitionCase(
            active.snapshot.case,
            "INGESTING",
            "generated execution",
            new Date("2026-07-19T20:00:01.000Z"),
          );
          return {
            ...active,
            snapshot: {
              ...active.snapshot,
              case: transitionCase(
                ingesting,
                "BLOCKED",
                "generated completion",
                at,
              ),
              job: transitionJob(active.snapshot.job, "FAILED", {
                at,
                failure: {
                  code: "GENERATED_TERMINAL",
                  message: "The generated worker stopped safely",
                  retryable: false,
                },
                progressPhase: "BLOCKED",
              }),
            },
            updatedAt: at.toISOString(),
          };
        } finally {
          cleanupCount += 1;
        }
      },
    },
  };
}
