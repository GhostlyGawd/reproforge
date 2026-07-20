import assert from "node:assert/strict";

import { PGlite } from "@electric-sql/pglite";
import { Given, Then, When } from "@cucumber/cucumber";

import {
  ACCOUNT_DELETION_CONFIRMATION,
  AccountDataService,
} from "@/application/account-data-service";
import type { AuditEvent } from "@/application/ports/production";
import {
  toReproductionProgress,
  type ProgressView,
} from "@/application/progress";
import type { ReproductionSnapshot } from "@/application/reproduction-contracts";
import { parsePortableTenantBackup } from "@/application/tenant-backup";
import { createCase, transitionCase } from "@/domain/case";
import { createJob, transitionJob } from "@/domain/job";
import { AuditSandboxQuarantineSink } from "@/infrastructure/execution/audit-sandbox-quarantine-sink";
import { JsonTenantBackupLogger } from "@/infrastructure/backup/observability";
import { PostgresTenantBackupService } from "@/infrastructure/backup/postgres-tenant-backup";
import { FeatureFlagRepositoryStartAdmission } from "@/infrastructure/operations/feature-start-admission";
import {
  PostgresSandboxQuarantineOperator,
  type QuarantineResource,
} from "@/infrastructure/operations/postgres-sandbox-quarantine-operator";
import { SandboxRunnerStartAdmission } from "@/infrastructure/operations/repository-start-admission";
import { PostgresAccountExportQuota } from "@/infrastructure/operations/postgres-account-export-quota";
import { applyPostgresMigrations } from "@/infrastructure/postgres/migrations";
import { PostgresAuditSink } from "@/infrastructure/postgres/repositories";
import { PostgresTenantDataRetention } from "@/infrastructure/retention/postgres-tenant-data-retention";
import { toReproductionView } from "@/mcp/contracts";
import { pgliteMigrationClient } from "../../tests/helpers/pglite-migration-client";
import { pglitePostgresDatabase } from "../../tests/helpers/pglite-postgres-database";
import { MemoryPrivateBlobClient } from "../../tests/helpers/memory-private-blob-client";
import {
  seedVerifiedBackupTenant,
  type VerifiedBackupFixture,
} from "../../tests/helpers/tenant-backup-fixture";
import type { ReproForgeWorld } from "../support/world";

const AT = new Date("2026-07-20T12:00:00.000Z");

type PrivateBetaScenarioState = {
  accountData?: {
    blobs: MemoryPrivateBlobClient;
    deletionResult?: Awaited<
      ReturnType<PostgresTenantDataRetention["executeNext"]>
    >;
    exported?: Awaited<ReturnType<AccountDataService["exportAccountData"]>>;
    fixture: VerifiedBackupFixture;
    retention: PostgresTenantDataRetention;
    service: AccountDataService;
  };
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
  "a completed private-beta repository case and the global start kill switch",
  function (this: ReproForgeWorld) {
    const current = scenarioState(this);
    let reproductionCase = createCase("case_private_beta_kill_switch", AT);
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
        `private beta kill-switch ${next.toLowerCase()}`,
        new Date(AT.getTime() + (index + 1) * 1_000),
      );
    });
    let job = transitionJob(
      createJob("job_private_beta_kill_switch", reproductionCase.id, AT),
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
  "the user reads the completed case and attempts a kill-switched repository start",
  async function (this: ReproForgeWorld) {
    const current = scenarioState(this);
    assert(current.completedSnapshot);
    current.completedRead = structuredClone(current.completedSnapshot);
    const admission = new FeatureFlagRepositoryStartAdmission({
      audit: {
        append: async (event) => {
          current.denialAudits.push(structuredClone(event));
        },
      },
      clock: { now: () => new Date("2026-07-20T12:40:00.000Z") },
      eventId: () => "audit_private_beta_feature_denied",
      flags: {
        disablePrivateRepositories: false,
        disableRepositoryStarts: true,
        disabledExecutionProfiles: [],
      },
    });
    const source = {
      commitSha: "b".repeat(40),
      executionProfile: {
        controlScript: "test:control",
        ecosystem: "node" as const,
        lockfile: "package-lock.json" as const,
        nodeVersion: "24" as const,
        packageManager: "npm" as const,
        reproductionScript: "test:reproduce",
      },
      failureOracle: {
        id: "oracle-private-beta-kill-switch",
        root: { expected: 1, type: "exit_code" as const },
        version: 1,
      },
      kind: "github" as const,
      repositoryId: "repo_private_beta_disabled",
    };
    try {
      await admission.assertAllowed(
        {
          callerId: "principal_private_beta",
          principalId: "principal_private_beta",
          tenantId: "tenant_private_beta",
        },
        source,
        {
          commitSha: source.commitSha,
          fullName: "synthetic-owner/private-beta-disabled",
          private: true,
          provider: "github",
          repositoryId: source.repositoryId,
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
  "the completed case remains readable during the start kill switch",
  function (this: ReproForgeWorld) {
    const current = scenarioState(this);
    assert.deepEqual(current.completedRead, current.completedSnapshot);
    assert.equal(current.completedRead?.case.state, "VERIFIED");
  },
);

Then(
  "the new start is denied with a sanitized feature-policy audit",
  function (this: ReproForgeWorld) {
    const current = scenarioState(this);
    assert.equal(current.denialCode, "REPOSITORY_STARTS_DISABLED");
    assert.deepEqual(current.denialAudits, [
      {
        action: "repository.start-denied",
        actorId: "principal_private_beta",
        eventId: "audit_private_beta_feature_denied",
        metadata: {
          code: "REPOSITORY_STARTS_DISABLED",
          executionProfile: "node24",
          repositoryId: "repo_private_beta_disabled",
        },
        occurredAt: "2026-07-20T12:40:00.000Z",
        outcome: "denied",
        targetId: "repo_private_beta_disabled",
        targetType: "repository",
        tenantId: "tenant_private_beta",
      },
    ]);
    assert.doesNotMatch(
      JSON.stringify(current.denialAudits),
      /private-beta-disabled/,
    );
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

Given(
  "a signed-in private-beta tenant with a retained verified case",
  { timeout: 30_000 },
  async function (this: ReproForgeWorld) {
    this.durableDatabase = new PGlite();
    await applyPostgresMigrations(
      pgliteMigrationClient(this.durableDatabase),
    );
    this.durablePostgres = pglitePostgresDatabase(this.durableDatabase);
    const blobs = new MemoryPrivateBlobClient();
    const fixture = await seedVerifiedBackupTenant(
      this.durableDatabase,
      blobs,
      "tenant_private_beta_data",
    );
    await this.durableDatabase.query(
      `INSERT INTO principals (
         tenant_id, id, provider, issuer, external_subject
       ) VALUES ($1, $2, 'auth0', $3, $4)`,
      [
        fixture.tenantId,
        fixture.callerId,
        "https://identity.private-beta.example/",
        "subject_private_beta_data",
      ],
    );
    const clock = { now: () => new Date("2026-07-20T18:00:00.000Z") };
    const audit = new PostgresAuditSink(this.durablePostgres);
    const retention = new PostgresTenantDataRetention(
      this.durablePostgres,
      blobs,
    );
    const backup = new PostgresTenantBackupService(
      this.durablePostgres,
      blobs,
      clock,
      new JsonTenantBackupLogger({
        sink: { error: () => undefined, info: () => undefined },
      }),
    );
    scenarioState(this).accountData = {
      blobs,
      fixture,
      retention,
      service: new AccountDataService({
        audit,
        backup,
        clock,
        exportQuota: new PostgresAccountExportQuota(this.durablePostgres),
        nextAuditEventId: () => "audit_private_beta_account_export",
        retention,
      }),
    };
  },
);

When(
  "the user exports the account and confirms deletion",
  async function (this: ReproForgeWorld) {
    const current = scenarioState(this).accountData;
    assert(current);
    const scope = {
      callerId: current.fixture.callerId,
      principalId: current.fixture.callerId,
      tenantId: current.fixture.tenantId,
    };
    current.exported = await current.service.exportAccountData(scope, {
      idempotencyKey: "private-beta-account-export",
    });
    await current.service.requestAccountDeletion(scope, {
      confirmation: ACCOUNT_DELETION_CONFIRMATION,
      idempotencyKey: "private-beta-account-delete",
    });
    current.deletionResult = await current.retention.executeNext({
      at: "2026-07-20T18:00:01.000Z",
      ownerId: "retention_private_beta_data",
    });
  },
);

Then(
  "the portable export preserves the verified private bundle",
  function (this: ReproForgeWorld) {
    const current = scenarioState(this).accountData;
    assert(current?.exported);
    const archive = parsePortableTenantBackup(current.exported.bytes);
    assert.equal(
      archive.manifest.tenant.tenantId,
      current.fixture.tenantId,
    );
    assert.equal(archive.manifest.reproductions.length, 1);
    assert.deepEqual(
      archive.objects[current.fixture.artifact.objectKey],
      current.fixture.body,
    );
  },
);

Then(
  "the tenant data is deleted with only a sanitized tombstone",
  async function (this: ReproForgeWorld) {
    assert(this.durableDatabase);
    const current = scenarioState(this).accountData;
    assert(current?.deletionResult);
    assert.equal(
      current.blobs.has(current.fixture.artifact.objectKey),
      false,
    );
    const lifecycle = await this.durableDatabase.query<{
      action: string;
      metadata: unknown;
      status: string;
    }>(
      `SELECT t.status, a.action, a.metadata
         FROM tenants t
         JOIN audit_events a ON a.tenant_id = t.id
        WHERE t.id = $1`,
      [current.fixture.tenantId],
    );
    assert.deepEqual(lifecycle.rows, [
      {
        action: "account.deleted",
        metadata: { reason: "user-request" },
        status: "DELETED",
      },
    ]);
  },
);
