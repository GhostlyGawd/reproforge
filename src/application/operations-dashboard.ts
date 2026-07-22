import { z } from "zod";

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const ageSeconds = count.nullable();
const healthStatus = z.enum(["ready", "unavailable"]);
const executionProfile = z.enum(["node22", "node24"]);

export const durableOperationsSnapshotSchema = z
  .object({
    deletions: z.object({ failed: count, pending: count }).strict(),
    jobs: z
      .object({
        cancelled: count,
        expiredLeases: count,
        failed: count,
        oldestQueuedAgeSeconds: ageSeconds,
        queued: count,
        running: count,
        succeeded: count,
      })
      .strict(),
    outbox: z
      .object({
        dead: count,
        oldestPendingAgeSeconds: ageSeconds,
        pending: count,
      })
      .strict(),
    quarantinedResources: count,
  })
  .strict();

export type DurableOperationsSnapshot = z.infer<
  typeof durableOperationsSnapshotSchema
>;

const alertCode = z.enum([
  "DEPENDENCY_READINESS_UNAVAILABLE",
  "RUNNER_UNAVAILABLE",
  "QUEUED_JOB_AGE_HIGH",
  "OUTBOX_LAG_HIGH",
  "EXPIRED_LEASES_PRESENT",
  "OUTBOX_DEAD_PRESENT",
  "DELETION_FAILURE_PRESENT",
  "SANDBOX_QUARANTINE_PRESENT",
]);

const alertSchema = z
  .object({
    code: alertCode,
    observed: z.union([count, healthStatus]),
    owner: z.literal("platform-on-call"),
    runbook: z.string().regex(/^docs\/operations\.md#[a-z0-9-]+$/),
    severity: z.enum(["critical", "warning"]),
    status: z.enum(["firing", "ok"]),
    testProcedure: z.string().min(1).max(256),
    threshold: z.string().min(1).max(128),
  })
  .strict();

export const operationsDashboardSchema = z
  .object({
    alerts: z.array(alertSchema).length(8),
    durable: durableOperationsSnapshotSchema,
    features: z
      .object({
        node22: z.enum(["enabled", "disabled"]),
        node24: z.enum(["enabled", "disabled"]),
        privateRepositories: z.enum(["enabled", "disabled"]),
        repositoryStarts: z.enum(["enabled", "disabled"]),
      })
      .strict(),
    generatedAt: z.string().datetime({ offset: true }),
    health: z
      .object({ readiness: healthStatus, runner: healthStatus })
      .strict(),
    schemaVersion: z.literal("1.0"),
  })
  .strict();

export type OperationsDashboard = z.infer<typeof operationsDashboardSchema>;

const inputSchema = z
  .object({
    at: z.string().datetime({ offset: true }),
    durable: durableOperationsSnapshotSchema,
    features: z
      .object({
        disablePrivateRepositories: z.boolean(),
        disableRepositoryStarts: z.boolean(),
        disabledExecutionProfiles: z
          .array(executionProfile)
          .max(2)
          .transform((profiles) => [...new Set(profiles)].sort()),
      })
      .strict(),
    health: z
      .object({ readiness: healthStatus, runner: healthStatus })
      .strict(),
  })
  .strict();

type AlertInput = Omit<z.input<typeof alertSchema>, "status"> & {
  firing: boolean;
};

function alert(input: AlertInput): z.output<typeof alertSchema> {
  const { firing, ...definition } = input;
  return alertSchema.parse({
    ...definition,
    status: firing ? "firing" : "ok",
  });
}

function age(value: number | null): number {
  return value ?? 0;
}

export function buildOperationsDashboard(
  rawInput: z.input<typeof inputSchema>,
): OperationsDashboard {
  const input = inputSchema.parse(rawInput);
  const alerts = [
    alert({
      code: "DEPENDENCY_READINESS_UNAVAILABLE",
      firing: input.health.readiness !== "ready",
      observed: input.health.readiness,
      owner: "platform-on-call",
      runbook: "docs/operations.md#alert-dependency-readiness-unavailable",
      severity: "critical",
      testProcedure: "npm run test:operations",
      threshold: "readiness != ready",
    }),
    alert({
      code: "RUNNER_UNAVAILABLE",
      firing: input.health.runner !== "ready",
      observed: input.health.runner,
      owner: "platform-on-call",
      runbook: "docs/operations.md#alert-runner-unavailable",
      severity: "critical",
      testProcedure: "npm run test -- tests/runtime-runner-health.test.ts",
      threshold: "runner != ready",
    }),
    alert({
      code: "QUEUED_JOB_AGE_HIGH",
      firing: age(input.durable.jobs.oldestQueuedAgeSeconds) >= 240,
      observed: age(input.durable.jobs.oldestQueuedAgeSeconds),
      owner: "platform-on-call",
      runbook: "docs/operations.md#alert-queued-job-age-high",
      severity: "warning",
      testProcedure: "npm run test -- tests/operations-dashboard.test.ts",
      threshold: ">= 240 seconds",
    }),
    alert({
      code: "OUTBOX_LAG_HIGH",
      firing: age(input.durable.outbox.oldestPendingAgeSeconds) >= 120,
      observed: age(input.durable.outbox.oldestPendingAgeSeconds),
      owner: "platform-on-call",
      runbook: "docs/operations.md#alert-outbox-lag-high",
      severity: "warning",
      testProcedure: "npm run test -- tests/operations-dashboard.test.ts",
      threshold: ">= 120 seconds",
    }),
    alert({
      code: "EXPIRED_LEASES_PRESENT",
      firing: input.durable.jobs.expiredLeases > 0,
      observed: input.durable.jobs.expiredLeases,
      owner: "platform-on-call",
      runbook: "docs/operations.md#alert-expired-leases-present",
      severity: "critical",
      testProcedure: "npm run test -- tests/job-lease-recovery.test.ts",
      threshold: "> 0 leases",
    }),
    alert({
      code: "OUTBOX_DEAD_PRESENT",
      firing: input.durable.outbox.dead > 0,
      observed: input.durable.outbox.dead,
      owner: "platform-on-call",
      runbook: "docs/operations.md#alert-outbox-dead-present",
      severity: "critical",
      testProcedure: "npm run test -- tests/outbox-publisher.test.ts",
      threshold: "> 0 events",
    }),
    alert({
      code: "DELETION_FAILURE_PRESENT",
      firing: input.durable.deletions.failed > 0,
      observed: input.durable.deletions.failed,
      owner: "platform-on-call",
      runbook: "docs/operations.md#alert-deletion-failure-present",
      severity: "critical",
      testProcedure: "npm run test -- tests/retention-deletion.test.ts",
      threshold: "> 0 requests",
    }),
    alert({
      code: "SANDBOX_QUARANTINE_PRESENT",
      firing: input.durable.quarantinedResources > 0,
      observed: input.durable.quarantinedResources,
      owner: "platform-on-call",
      runbook: "docs/operations.md#alert-sandbox-quarantine-present",
      severity: "critical",
      testProcedure: "npm run test -- tests/sandbox-quarantine-operator.test.ts",
      threshold: "> 0 resources",
    }),
  ];

  return operationsDashboardSchema.parse({
    alerts,
    durable: input.durable,
    features: {
      node22: input.features.disabledExecutionProfiles.includes("node22")
        ? "disabled"
        : "enabled",
      node24: input.features.disabledExecutionProfiles.includes("node24")
        ? "disabled"
        : "enabled",
      privateRepositories: input.features.disablePrivateRepositories
        ? "disabled"
        : "enabled",
      repositoryStarts: input.features.disableRepositoryStarts
        ? "disabled"
        : "enabled",
    },
    generatedAt: input.at,
    health: input.health,
    schemaVersion: "1.0",
  });
}
