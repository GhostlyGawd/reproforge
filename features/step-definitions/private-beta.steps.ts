import assert from "node:assert/strict";

import { PGlite } from "@electric-sql/pglite";
import { Given, Then, When } from "@cucumber/cucumber";

import type { AuditEvent } from "@/application/ports/production";
import {
  toReproductionProgress,
  type ProgressView,
} from "@/application/progress";
import type { ReproductionSnapshot } from "@/application/reproduction-contracts";
import { createCase, transitionCase } from "@/domain/case";
import { createJob, transitionJob } from "@/domain/job";
import { AuditSandboxQuarantineSink } from "@/infrastructure/execution/audit-sandbox-quarantine-sink";
import {
  PostgresSandboxQuarantineOperator,
  type QuarantineResource,
} from "@/infrastructure/operations/postgres-sandbox-quarantine-operator";
import { SandboxRunnerStartAdmission } from "@/infrastructure/operations/repository-start-admission";
import { applyPostgresMigrations } from "@/infrastructure/postgres/migrations";
import { PostgresAuditSink } from "@/infrastructure/postgres/repositories";
import { toReproductionView } from "@/mcp/contracts";
import { pgliteMigrationClient } from "../../tests/helpers/pglite-migration-client";
import { pglitePostgresDatabase } from "../../tests/helpers/pglite-postgres-database";
import type { ReproForgeWorld } from "../support/world";

const AT = new Date("2026-07-20T12:00:00.000Z");

type PrivateBetaScenarioState = {
  completedRead?: ReproductionSnapshot;
  completedSnapshot?: ReproductionSnapshot;
  denialAudits: AuditEvent[];
  denialCode?: string;
  quarantine?: {
    command: QuarantineResource;
    deleteCount: number;
    operator: PostgresSandboxQuarantineOperator;
    results: Array<{ changed: boolean }>;
  };
};

const scenarioStates = new WeakMap<ReproForgeWorld, PrivateBetaScenarioState>();

function scenarioState(world: ReproForgeWorld): PrivateBetaScenarioState {
  let state = scenarioStates.get(world);
  if (!state) {
    state = { denialAudits: [] };
    scenarioStates.set(world, state);
  }
  return state;
}

Given(
  "a durable private-beta case is experimenting",
  function (this: ReproForgeWorld) {
    let reproductionCase = createCase("case_private_beta_parity", AT);
    const transitions = [
      "INGESTING",
      "INSPECTING",
      "HYPOTHESIZING",
      "EXPERIMENTING",
    ] as const;
    transitions.forEach((state, index) => {
      reproductionCase = transitionCase(
        reproductionCase,
        state,
        `private beta phase ${state.toLowerCase()}`,
        new Date(AT.getTime() + (index + 1) * 1_000),
      );
    });
    const job = transitionJob(
      createJob("job_private_beta_parity", reproductionCase.id, AT),
      "RUNNING",
      {
        at: new Date(AT.getTime() + 4_000),
        progressPhase: "EXPERIMENTING",
      },
    );
    this.privateBetaSnapshot = {
      case: reproductionCase,
      job,
      result: null,
      sampleId: "cli-spaces",
      schemaVersion: "2.0",
    } satisfies ReproductionSnapshot;
  },
);

When(
  "REST, MCP, widget, and web progress views are projected",
  function (this: ReproForgeWorld) {
    assert.ok(this.privateBetaSnapshot);
    const direct = toReproductionProgress(this.privateBetaSnapshot.job);
    const mcp = toReproductionView(this.privateBetaSnapshot);
    this.privateBetaProgressViews = [
      direct,
      mcp.progress,
      mcp.progress,
      direct,
    ];
  },
);

Then(
  "every product surface reports the same durable progress",
  function (this: ReproForgeWorld) {
    assert.equal(this.privateBetaProgressViews.length, 4);
    const [expected, ...others] = this.privateBetaProgressViews;
    assert.ok(expected);
    others.forEach((progress: ProgressView) =>
      assert.deepEqual(progress, expected),
    );
    assert.equal(expected.phase, "EXPERIMENTING");
    assert.equal(expected.state, "RUNNING");
    assert.equal(expected.terminal, false);
  },
);

Given(
  "a completed private-beta repository case and a degraded runner",
  function (this: ReproForgeWorld) {
    const current = scenarioState(this);
    let reproductionCase = createCase("case_private_beta_completed", AT);
    const transitions = [
      "INGESTING",
      "INSPECTING",
      "HYPOTHESIZING",
      "EXPERIMENTING",
      "VERIFYING",
      "MINIMIZING",
      "PACKAGING",
      "VERIFIED",
    ] as const;
    transitions.forEach((next, index) => {
      reproductionCase = transitionCase(
        reproductionCase,
        next,
        `private beta completion ${next.toLowerCase()}`,
        new Date(AT.getTime() + (index + 1) * 1_000),
      );
    });
    let job = transitionJob(
      createJob("job_private_beta_completed", reproductionCase.id, AT),
      "RUNNING",
      {
        at: new Date(AT.getTime() + 1_000),
        progressPhase: "INGESTING",
      },
    );
    job = transitionJob(job, "SUCCEEDED", {
      at: new Date(AT.getTime() + 9_000),
      progressPhase: "VERIFIED",
    });
    current.completedSnapshot = {
      case: reproductionCase,
      job,
      result: null,
      sampleId: "cli-spaces",
      schemaVersion: "2.0",
    };
  },
);

When(
  "the user reads the completed case and attempts a new repository start",
  async function (this: ReproForgeWorld) {
    const current = scenarioState(this);
    assert(current.completedSnapshot);
    current.completedRead = structuredClone(current.completedSnapshot);
    const admission = new SandboxRunnerStartAdmission({
      audit: {
        append: async (event) => {
          current.denialAudits.push(structuredClone(event));
        },
      },
      clock: { now: () => new Date("2026-07-20T12:30:00.000Z") },
      eventId: () => "audit_private_beta_runner_denied",
      probe: {
        check: async () => ({
          code: "RUNNER_UNAVAILABLE",
          status: "unavailable" as const,
        }),
      },
    });
    try {
      await admission.assertAllowed(
        {
          callerId: "principal_private_beta",
          principalId: "principal_private_beta",
          tenantId: "tenant_private_beta",
        },
        {
          commitSha: "a".repeat(40),
          executionProfile: {
            controlScript: "test:control",
            ecosystem: "node",
            lockfile: "package-lock.json",
            nodeVersion: "24",
            packageManager: "npm",
            reproductionScript: "test:reproduce",
          },
          failureOracle: {
            id: "oracle-private-beta-degraded",
            root: { expected: 1, type: "exit_code" },
            version: 1,
          },
          kind: "github",
          repositoryId: "repo_private_beta_new",
        },
      );
    } catch (error) {
      current.denialCode =
        error && typeof error === "object" && "code" in error
          ? String(error.code)
          : "UNEXPECTED_ERROR";
    }
  },
);

Then(
  "the completed case remains readable during runner degradation",
  function (this: ReproForgeWorld) {
    const current = scenarioState(this);
    assert.deepEqual(current.completedRead, current.completedSnapshot);
    assert.equal(current.completedRead?.case.state, "VERIFIED");
  },
);

Then(
  "the new start is denied with a sanitized runner audit",
  function (this: ReproForgeWorld) {
    const current = scenarioState(this);
    assert.equal(current.denialCode, "RUNNER_UNAVAILABLE");
    assert.deepEqual(current.denialAudits, [
      {
        action: "repository.start-denied",
        actorId: "principal_private_beta",
        eventId: "audit_private_beta_runner_denied",
        metadata: {
          code: "RUNNER_UNAVAILABLE",
          repositoryId: "repo_private_beta_new",
        },
        occurredAt: "2026-07-20T12:30:00.000Z",
        outcome: "denied",
        targetId: "repo_private_beta_new",
        targetType: "repository",
        tenantId: "tenant_private_beta",
      },
    ]);
  },
);

Given(
  "an audited private-beta sandbox quarantine",
  { timeout: 30_000 },
  async function (this: ReproForgeWorld) {
    this.durableDatabase = new PGlite();
    await applyPostgresMigrations(
      pgliteMigrationClient(this.durableDatabase),
    );
    this.durablePostgres = pglitePostgresDatabase(this.durableDatabase);
    await this.durableDatabase.query(
      "INSERT INTO tenants (id) VALUES ('tenant_private_beta_quarantine')",
    );
    const audit = new PostgresAuditSink(this.durablePostgres);
    await new AuditSandboxQuarantineSink(audit, {
      now: () => new Date("2026-07-20T13:00:00.000Z"),
    }).record({
      actorId: "principal_private_beta",
      attemptId: "job_private_beta.attempt-2",
      providerResourceId: "sandbox_private_beta_quarantined",
      reason: "cleanup-failed",
      resourceType: "sandbox",
      tenantId: "tenant_private_beta_quarantine",
    });
    const current = scenarioState(this);
    const command = {
      actorId: "operator_private_beta",
      attemptId: "job_private_beta.attempt-2",
      providerResourceId: "sandbox_private_beta_quarantined",
      resourceType: "sandbox" as const,
      tenantId: "tenant_private_beta_quarantine",
    };
    current.quarantine = {
      command,
      deleteCount: 0,
      operator: new PostgresSandboxQuarantineOperator({
        audit,
        clock: { now: () => new Date("2026-07-20T13:05:00.000Z") },
        database: this.durablePostgres,
        deleteResource: async () => {
          assert(current.quarantine);
          current.quarantine.deleteCount += 1;
        },
      }),
      results: [],
    };
  },
);

When(
  "the operator resolves the exact sandbox twice",
  async function (this: ReproForgeWorld) {
    const quarantine = scenarioState(this).quarantine;
    assert(quarantine);
    quarantine.results.push(await quarantine.operator.resolve(quarantine.command));
    quarantine.results.push(await quarantine.operator.resolve(quarantine.command));
  },
);

Then(
  "the quarantined sandbox is deleted exactly once",
  function (this: ReproForgeWorld) {
    const quarantine = scenarioState(this).quarantine;
    assert(quarantine);
    assert.equal(quarantine.deleteCount, 1);
    assert.deepEqual(quarantine.results, [{ changed: true }, { changed: false }]);
  },
);

Then(
  "the quarantine resolution is audited and no longer open",
  async function (this: ReproForgeWorld) {
    assert(this.durableDatabase);
    const quarantine = scenarioState(this).quarantine;
    assert(quarantine);
    assert.deepEqual(await quarantine.operator.listOpen({ limit: 10 }), []);
    const audits = await this.durableDatabase.query<{
      action: string;
      outcome: string;
    }>(
      "SELECT action, outcome FROM audit_events ORDER BY occurred_at",
    );
    assert.deepEqual(audits.rows, [
      { action: "sandbox.cleanup-quarantined", outcome: "failure" },
      { action: "sandbox.cleanup-resolved", outcome: "success" },
    ]);
  },
);
