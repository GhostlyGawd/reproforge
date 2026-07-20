import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { Before, Given, Then, When } from "@cucumber/cucumber";

import { createCase } from "@/domain/case";
import { validateMaterializedBundle } from "@/domain/bundle";
import type { FailureOracle } from "@/domain/oracle";
import {
  ExecutionLimitError,
  type BoundedExperimentResult,
} from "@/execution/bounded-execution";
import {
  immutableRepositorySourceSchema,
  type IsolatedSandboxProvider,
  type IsolatedSandboxSession,
  type NodeRepositoryProfile,
  type SandboxCommand,
  type SandboxCommandResult,
  type SandboxNetworkPolicy,
} from "@/execution/contracts";
import {
  NodeDependencyPreparer,
  validateNodeDependencyMetadata,
  type DependencyMetadata,
} from "@/execution/dependency-preparation";
import {
  buildNodeExecutionPlan,
  type ExecutionEnvironmentProvenance,
} from "@/execution/execution-planning";
import {
  assembleRepositoryProof,
  type RepositoryProofInput,
  type RepositoryProofResult,
} from "@/execution/repository-proof";
import { SnapshotRunCoordinator } from "@/execution/sandbox-lifecycle";
import {
  validateArchiveManifest,
  type ArchiveManifest,
  type SourceProvenance,
} from "@/execution/source-provenance";
import type { ReproForgeWorld } from "../support/world";

const profile: NodeRepositoryProfile = {
  controlScript: "test:control",
  ecosystem: "node",
  lockfile: "package-lock.json",
  nodeVersion: "24",
  packageManager: "npm",
  reproductionScript: "test:reproduce",
};
const oracle: FailureOracle = {
  id: "bdd-repository-oracle",
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
const source = {
  commitSha: "a".repeat(40),
  fullName: "acme/repository",
  private: false,
  provider: "github" as const,
  repositoryId: "bdd_repository",
};
const sourceProvenance: SourceProvenance = {
  acquiredAt: "2026-07-20T12:00:00.000Z",
  archiveBytes: 4_096,
  archiveSha256: "b".repeat(64),
  commitSha: source.commitSha,
  extractedBytes: 8_192,
  fileCount: 4,
  manifestSha256: "c".repeat(64),
  policyVersion: "source-archive-v1",
  provider: "github",
  repositoryId: source.repositoryId,
  schemaVersion: "1.0",
};
const dependency: DependencyMetadata = {
  dependencyCount: 0,
  lockfileSha256: "d".repeat(64),
  lockfileVersion: 3,
  packageJsonSha256: "e".repeat(64),
  policyVersion: "node-lock-v1",
};
const environment: ExecutionEnvironmentProvenance = {
  archiveSha256: sourceProvenance.archiveSha256,
  dependencyPolicyVersion: "node-lock-v1",
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
  sourcePolicyVersion: "source-archive-v1",
  vcpus: 2,
};
const dependencyManifest: ArchiveManifest = {
  archiveBytes: 1_024,
  archiveSha256: "9".repeat(64),
  extractedBytes: 512,
  fileCount: 2,
  files: [
    { path: "package-lock.json", size: 256 },
    { path: "package.json", size: 256 },
  ],
  rootDirectory: "repository-root",
};

type DependencyFixture = {
  commands: SandboxCommand[];
  policies: SandboxNetworkPolicy[];
  preparer: NodeDependencyPreparer;
  session: IsolatedSandboxSession;
  timeline: string[];
};

type LifecycleFixture = {
  cleanupCount: () => number;
  coordinator: SnapshotRunCoordinator;
  prepared: IsolatedSandboxSession;
};

type State = {
  archiveRejected?: boolean;
  dependency?: DependencyFixture;
  errorCode?: string;
  extractionCount: number;
  input?: RepositoryProofInput;
  lifecycle?: LifecycleFixture;
  privateInput?: RepositoryProofInput;
  privateProof?: RepositoryProofResult;
  proof?: RepositoryProofResult;
  providerCalls: number;
  publicInput?: RepositoryProofInput;
  publicProof?: RepositoryProofResult;
  repositoryCommands: number;
  secret?: string;
};

const states = new WeakMap<ReproForgeWorld, State>();

Before(function (this: ReproForgeWorld) {
  states.set(this, {
    extractionCount: 0,
    providerCalls: 0,
    repositoryCommands: 0,
  });
});

function state(world: ReproForgeWorld): State {
  const current = states.get(world);
  assert(current, "isolated repository BDD state is required");
  return current;
}

function capture(text: string) {
  const bytes = new TextEncoder().encode(text);
  return {
    originalBytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    text,
    truncated: false,
  };
}

function boundedRun(id: string, exitCode: number, stderr: string) {
  const control = id.startsWith("control");
  return {
    capture: { stderr: capture(stderr), stdout: capture("") },
    role: control ? ("control" as const) : ("candidate" as const),
    run: {
      command: control ? "npm run test:control" : "npm run test:reproduce",
      durationMs: 10,
      environmentHash: environment.environmentHash,
      exitCode,
      id,
      stderr,
      stdout: "",
    },
  };
}

function proofInput(options: {
  candidateCodes?: number[];
  controlCode?: number;
  private?: boolean;
  secret?: string;
} = {}): RepositoryProofInput {
  const candidateCodes = options.candidateCodes ?? [1, 1, 1];
  const candidateError = options.secret
    ? `synthetic failure ${options.secret}`
    : "synthetic failure";
  const execution: BoundedExperimentResult = {
    candidates: candidateCodes.map((code, index) =>
      boundedRun(
        `candidate-${index + 1}`,
        code,
        code === 1 ? candidateError : "",
      ),
    ),
    control: boundedRun(
      "control-1",
      options.controlCode ?? 0,
      options.controlCode === 1 ? "synthetic failure" : "",
    ),
    limitsPolicyVersion: "sandbox-limits-v1",
    totalDurationMs: 40,
  };
  return {
    budget: { maxToolCalls: 6, requiredRuns: 3 },
    case: createCase(
      "bdd_repository_case",
      new Date("2026-07-20T12:00:00.000Z"),
    ),
    cleanupStatus: "clean",
    dependency,
    environment,
    execution,
    generatedAt: "2026-07-20T12:00:20.000Z",
    issueEvidence: { number: 42, title: "Synthetic repository failure" },
    oracle,
    profile,
    secrets: options.secret ? [options.secret] : [],
    source: { ...source, private: options.private ?? false },
    sourceProvenance,
  };
}

function dependencyBytes(lockfileVersion = 3) {
  return {
    lock: new TextEncoder().encode(
      JSON.stringify({
        lockfileVersion,
        name: "bdd-repository",
        packages: { "": { name: "bdd-repository", version: "1.0.0" } },
        requires: true,
        version: "1.0.0",
      }),
    ),
    package: new TextEncoder().encode(
      JSON.stringify({
        name: "bdd-repository",
        private: true,
        scripts: {
          "test:control": "node control.mjs",
          "test:reproduce": "node reproduce.mjs",
        },
        version: "1.0.0",
      }),
    ),
  };
}

function dependencyFixture(): DependencyFixture {
  const bytes = dependencyBytes();
  const commands: SandboxCommand[] = [];
  const policies: SandboxNetworkPolicy[] = [];
  const timeline: string[] = [];
  const commandResult: SandboxCommandResult = {
    durationMs: 1,
    exitCode: 0,
    stderr: new Uint8Array(),
    stdout: new Uint8Array(),
  };
  const session: IsolatedSandboxSession = {
    makeDirectory: async () => undefined,
    readFile: async (path) =>
      path.endsWith("package-lock.json") ? bytes.lock : bytes.package,
    run: async (command) => {
      commands.push(command);
      timeline.push(`command:${command.phase}`);
      return commandResult;
    },
    sandboxId: "bdd_dependency_sandbox",
    setNetworkPolicy: async (policy) => {
      policies.push(policy);
      timeline.push(
        `policy:${policy.kind === "deny-all" ? "deny-all" : policy.phase}`,
      );
    },
    snapshot: async () => ({
      delete: async () => undefined,
      snapshotId: "bdd_dependency_snapshot",
    }),
    stop: async () => undefined,
    usage: async () => ({
      activeCpuMs: 0,
      networkEgressBytes: 0,
      networkIngressBytes: 0,
    }),
    writeFiles: async () => undefined,
  };
  return {
    commands,
    policies,
    preparer: new NodeDependencyPreparer(),
    session,
    timeline,
  };
}

function lifecycleFixture(options: {
  restoreFailure?: boolean;
} = {}): LifecycleFixture {
  let cleaned = 0;
  const result: SandboxCommandResult = {
    durationMs: 0,
    exitCode: 0,
    stderr: new Uint8Array(),
    stdout: new Uint8Array(),
  };
  const session = (
    id: string,
    snapshot?: IsolatedSandboxSession["snapshot"],
  ): IsolatedSandboxSession => ({
    makeDirectory: async () => undefined,
    readFile: async () => null,
    run: async () => result,
    sandboxId: id,
    setNetworkPolicy: async () => undefined,
    snapshot:
      snapshot ??
      (async () => ({
        delete: async () => undefined,
        snapshotId: "bdd_unused_snapshot",
      })),
    stop: async () => {
      cleaned += 1;
    },
    usage: async () => ({
      activeCpuMs: 0,
      networkEgressBytes: 0,
      networkIngressBytes: 0,
    }),
    writeFiles: async () => undefined,
  });
  const prepared = session("bdd_prepared", async () => ({
    delete: async () => {
      cleaned += 1;
    },
    snapshotId: "bdd_snapshot",
  }));
  let restoreSequence = 0;
  const provider: IsolatedSandboxProvider = {
    create: async () => {
      throw new Error("not used");
    },
    createFromSnapshot: async () => {
      restoreSequence += 1;
      if (options.restoreFailure) throw new Error("synthetic provider failure");
      return session(`bdd_restored_${restoreSequence}`);
    },
  };
  return {
    cleanupCount: () => cleaned,
    coordinator: new SnapshotRunCoordinator({
      provider,
      quarantine: { record: async () => undefined },
    }),
    prepared,
  };
}

Given(
  "an authorized public Node repository proof input",
  function (this: ReproForgeWorld) {
    state(this).input = proofInput();
  },
);

Given(
  "equivalent authorized public and private Node repository proof inputs",
  function (this: ReproForgeWorld) {
    state(this).publicInput = proofInput({ private: false });
    state(this).privateInput = proofInput({ private: true });
  },
);

When("the repository proof is assembled", async function (this: ReproForgeWorld) {
  const current = state(this);
  assert(current.input, "repository proof input is required");
  current.proof = await assembleRepositoryProof(current.input);
});

When(
  "both repository proofs are assembled",
  async function (this: ReproForgeWorld) {
    const current = state(this);
    assert(current.publicInput && current.privateInput, "proof inputs are required");
    current.publicProof = await assembleRepositoryProof(current.publicInput);
    current.privateProof = await assembleRepositoryProof(current.privateInput);
  },
);

Then(
  "the repository outcome is {string}",
  function (this: ReproForgeWorld, outcome: string) {
    assert.equal(state(this).proof?.summary.status, outcome);
  },
);

Then(
  "the repository bundle validates independently",
  function (this: ReproForgeWorld) {
    const proof = state(this).proof;
    assert(proof?.bundle, "verified repository bundle is required");
    assert.deepEqual(validateMaterializedBundle(proof.files), {
      errors: [],
      success: true,
    });
  },
);

Then(
  "the public and private proof shapes are identical",
  function (this: ReproForgeWorld) {
    const current = state(this);
    assert(current.publicProof && current.privateProof, "proofs are required");
    assert.deepEqual(current.privateProof, current.publicProof);
  },
);

Given(
  "a repository request without an immutable revision",
  function (this: ReproForgeWorld) {
    state(this).input = {
      ...proofInput(),
      source: { ...source, commitSha: "main" },
    } as never;
  },
);

When(
  "the repository source contract is validated",
  function (this: ReproForgeWorld) {
    const current = state(this);
    const parsed = immutableRepositorySourceSchema.safeParse(
      current.input?.source,
    );
    current.errorCode = parsed.success ? undefined : "UNSUPPORTED_SOURCE";
  },
);

Then(
  "the repository error code is {string}",
  function (this: ReproForgeWorld, code: string) {
    assert.equal(state(this).errorCode, code);
  },
);

Then("no repository provider operation ran", function (this: ReproForgeWorld) {
  assert.equal(state(this).providerCalls, 0);
});

Given(
  "a Node repository with an unsupported lockfile",
  function (this: ReproForgeWorld) {
    const current = state(this);
    const bytes = dependencyBytes(1);
    current.input = {
      ...proofInput(),
      dependency: {
        ...dependency,
        lockfileVersion: 3,
      },
    };
    current.publicInput = { lockBytes: bytes.lock, packageBytes: bytes.package } as never;
  },
);

When("its dependency metadata is validated", function (this: ReproForgeWorld) {
  const current = state(this);
  const bytes = current.publicInput as unknown as {
    lockBytes: Uint8Array;
    packageBytes: Uint8Array;
  };
  try {
    validateNodeDependencyMetadata({
      ...bytes,
      manifest: dependencyManifest,
      profile,
    });
  } catch (error) {
    current.errorCode =
      error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "UNEXPECTED_ERROR";
  }
});

Then("no repository command ran", function (this: ReproForgeWorld) {
  assert.equal(state(this).repositoryCommands, 0);
});

Given(
  "a repository archive with a traversal path",
  function (this: ReproForgeWorld) {
    state(this).input = {
      ...proofInput(),
      sourceProvenance: {
        ...sourceProvenance,
        manifest: {
          archiveBytes: 100,
          archiveSha256: "8".repeat(64),
          entries: [
            { path: "root/package.json", size: 1, type: "file" },
            { path: "root/../../etc/passwd", size: 1, type: "file" },
          ],
        },
      },
    } as never;
  },
);

When("its archive manifest is validated", function (this: ReproForgeWorld) {
  const current = state(this);
  const candidate = (current.input?.sourceProvenance as unknown as {
    manifest: Parameters<typeof validateArchiveManifest>[0];
  }).manifest;
  try {
    validateArchiveManifest(candidate);
  } catch {
    current.archiveRejected = true;
  }
});

Then("the archive is rejected before extraction", function (this: ReproForgeWorld) {
  const current = state(this);
  assert.equal(current.archiveRejected, true);
  assert.equal(current.extractionCount, 0);
});

Given(
  "a supported npm repository dependency fixture",
  function (this: ReproForgeWorld) {
    state(this).dependency = dependencyFixture();
  },
);

When("repository dependencies are prepared", async function (this: ReproForgeWorld) {
  const fixture = state(this).dependency;
  assert(fixture, "dependency fixture is required");
  await fixture.preparer.prepare({
    manifest: dependencyManifest,
    profile,
    session: fixture.session,
    sourceWorkspace: "/vercel/sandbox/workspaces/source",
  });
});

When(
  "repository dependencies and the execution plan are prepared",
  async function (this: ReproForgeWorld) {
    const current = state(this);
    const fixture = current.dependency;
    assert(fixture, "dependency fixture is required");
    const prepared = await fixture.preparer.prepare({
      manifest: dependencyManifest,
      profile,
      session: fixture.session,
      sourceWorkspace: "/vercel/sandbox/workspaces/source",
    });
    assert.equal(prepared.networkPolicy, "deny-all");
    const plan = buildNodeExecutionPlan({ profile, requiredRuns: 3, source });
    current.repositoryCommands = plan.commands.filter(
      (command) => command.phase === "control" || command.phase === "candidate",
    ).length;
  },
);

Then(
  "every npm install disables lifecycle scripts",
  function (this: ReproForgeWorld) {
    const fixture = state(this).dependency;
    assert(fixture, "dependency fixture is required");
    const installs = fixture.commands.filter(
      (command) => command.executable === "npm" && command.args[0] === "ci",
    );
    assert.equal(installs.length, 2);
    assert.equal(
      installs.every((command) => command.args.includes("--ignore-scripts")),
      true,
    );
  },
);

Then(
  "repository-controlled commands follow the deny-all boundary",
  function (this: ReproForgeWorld) {
    const current = state(this);
    const fixture = current.dependency;
    assert(fixture, "dependency fixture is required");
    assert.deepEqual(fixture.policies.at(-1), { kind: "deny-all" });
    assert.equal(current.repositoryCommands, 4);
    const denyIndex = fixture.timeline.lastIndexOf("policy:deny-all");
    const offlineIndex = fixture.timeline.indexOf("command:offline-install");
    assert(denyIndex >= 0 && denyIndex < offlineIndex);
  },
);

Given(
  "repository evidence whose control matches the failure",
  function (this: ReproForgeWorld) {
    state(this).input = proofInput({ controlCode: 1 });
  },
);

Given(
  "intermittent repository candidate evidence",
  function (this: ReproForgeWorld) {
    state(this).input = proofInput({ candidateCodes: [1, 0, 1] });
  },
);

Then("no repository bundle is emitted", function (this: ReproForgeWorld) {
  const proof = state(this).proof;
  assert(proof, "repository proof is required");
  assert.equal(proof.bundle, null);
  assert.deepEqual(proof.files, {});
});

Given(
  "a repository experiment that exceeds its workspace budget",
  function (this: ReproForgeWorld) {
    state(this).lifecycle = lifecycleFixture();
  },
);

When(
  "the isolated lifecycle executes the budgeted experiment",
  async function (this: ReproForgeWorld) {
    const current = state(this);
    assert(current.lifecycle, "lifecycle fixture is required");
    try {
      await current.lifecycle.coordinator.execute({
        attemptId: "bdd_budget_attempt",
        preparedSession: current.lifecycle.prepared,
        run: async () => {
          throw new ExecutionLimitError("WORKSPACE_LIMIT_EXCEEDED");
        },
        runCount: 1,
      });
    } catch (error) {
      current.errorCode =
        error && typeof error === "object" && "code" in error
          ? String(error.code)
          : "UNEXPECTED_ERROR";
    }
  },
);

Then(
  "every allocated sandbox resource is cleaned",
  function (this: ReproForgeWorld) {
    assert.equal(state(this).lifecycle?.cleanupCount(), 3);
  },
);

Given(
  "an active cancellable repository experiment",
  function (this: ReproForgeWorld) {
    state(this).lifecycle = lifecycleFixture();
  },
);

When("the repository experiment is cancelled", async function (this: ReproForgeWorld) {
  const current = state(this);
  assert(current.lifecycle, "lifecycle fixture is required");
  const controller = new AbortController();
  const started = Promise.withResolvers<void>();
  const execution = current.lifecycle.coordinator.execute({
    attemptId: "bdd_cancel_attempt",
    preparedSession: current.lifecycle.prepared,
    run: async ({ signal }) => {
      started.resolve();
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new DOMException("cancelled", "AbortError")),
          { once: true },
        );
      });
      return "unreachable";
    },
    runCount: 1,
    signal: controller.signal,
  });
  await started.promise;
  controller.abort();
  try {
    await execution;
  } catch (error) {
    current.errorCode =
      error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "UNEXPECTED_ERROR";
  }
});

Given(
  "a repository provider that cannot restore a sandbox",
  function (this: ReproForgeWorld) {
    state(this).lifecycle = lifecycleFixture({ restoreFailure: true });
  },
);

When(
  "the isolated lifecycle attempts the repository experiment",
  async function (this: ReproForgeWorld) {
    const current = state(this);
    assert(current.lifecycle, "lifecycle fixture is required");
    try {
      await current.lifecycle.coordinator.execute({
        attemptId: "bdd_provider_attempt",
        preparedSession: current.lifecycle.prepared,
        run: async () => "unreachable",
        runCount: 1,
      });
    } catch (error) {
      current.errorCode =
        error && typeof error === "object" && "code" in error
          ? String(error.code)
          : "UNEXPECTED_ERROR";
    }
  },
);

Then("no verified repository proof exists", function (this: ReproForgeWorld) {
  assert.notEqual(state(this).proof?.summary.status, "VERIFIED");
});

Given(
  "repository evidence containing a synthetic GitHub token",
  function (this: ReproForgeWorld) {
    const secret = "ghs_bdd_synthetic_github_token";
    const current = state(this);
    current.secret = secret;
    current.input = proofInput({ secret });
  },
);

Then(
  "the synthetic GitHub token is absent from proof and bundle",
  function (this: ReproForgeWorld) {
    const current = state(this);
    assert(current.proof && current.secret, "proof and secret are required");
    const serialized = JSON.stringify(current.proof);
    assert.equal(serialized.includes(current.secret), false);
    assert.equal(serialized.includes("[REDACTED]"), true);
  },
);
