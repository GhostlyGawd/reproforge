import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

import {
  formatOperatorFailure,
  runOperatorCommand,
} from "@/application/operator-command";
import { buildOperationsDashboard } from "@/application/operations-dashboard";
import { OutboxPublisher } from "@/application/outbox-publisher";
import {
  parsePortableTenantBackup,
  serializePortableTenantBackup,
} from "@/application/tenant-backup";
import { getRuntimeConfig } from "@/config/runtime";
import { VercelPrivateBlobClient } from "@/infrastructure/artifacts/vercel-private-blob-client";
import { JsonTenantBackupLogger } from "@/infrastructure/backup/observability";
import { PostgresTenantBackupService } from "@/infrastructure/backup/postgres-tenant-backup";
import {
  InMemoryOperationalMetrics,
  JsonOperationalLogger,
} from "@/infrastructure/operations/observability";
import { PostgresOperationsDashboardSource } from "@/infrastructure/operations/postgres-operations-dashboard";
import { PostgresSandboxQuarantineOperator } from "@/infrastructure/operations/postgres-sandbox-quarantine-operator";
import { createRuntimeHealthService } from "@/infrastructure/operations/runtime-health";
import { applyPostgresMigrations } from "@/infrastructure/postgres/migrations";
import {
  createNeonPostgresDatabase,
  type NeonPostgresDatabase,
} from "@/infrastructure/postgres/neon-database";
import {
  PostgresAuditSink,
  PostgresDurableReproductionRepository,
  PostgresOutbox,
} from "@/infrastructure/postgres/repositories";
import { VercelJobQueue } from "@/infrastructure/queue/vercel-job-queue";
import { PostgresTenantDataRetention } from "@/infrastructure/retention/postgres-tenant-data-retention";

async function main(): Promise<void> {
  let database: NeonPostgresDatabase | undefined;
  try {
    const runtime = getRuntimeConfig();
    if (runtime.mode !== "preview" && runtime.mode !== "production") {
      throw new Error("Hosted runtime required");
    }
    database = createNeonPostgresDatabase(runtime.credentials.databaseUrl);
    await applyPostgresMigrations(database);

    const clock = { now: () => new Date() };
    const blobs = new VercelPrivateBlobClient(runtime.credentials.blob);
    const backup = new PostgresTenantBackupService(
      database,
      blobs,
      clock,
      new JsonTenantBackupLogger(),
    );
    const retention = new PostgresTenantDataRetention(database, blobs);
    const repository = new PostgresDurableReproductionRepository(database);
    const outboxPublisher = new OutboxPublisher({
      claimSeconds: runtime.outboxClaimSeconds,
      clock,
      maxAttempts: runtime.maxDeliveryAttempts,
      maxBatchSize: runtime.outboxBatchSize,
      outbox: new PostgresOutbox(database),
      ownerId: `operator_publisher_${randomUUID()}`,
      queue: new VercelJobQueue({
        region: runtime.queueRegion,
        retentionSeconds: runtime.queueRetentionSeconds,
        topic: runtime.queueTopic,
      }),
    });
    const quarantine = new PostgresSandboxQuarantineOperator({
      audit: new PostgresAuditSink(database),
      clock,
      database,
    });
    const dashboardSource = new PostgresOperationsDashboardSource(database);
    const dashboardSnapshot = async () => {
      const generatedAt = clock.now().toISOString();
      const health = createRuntimeHealthService({
        clock,
        environment: process.env,
        logger: new JsonOperationalLogger({
          secrets: [
            process.env.DATABASE_URL,
            process.env.BLOB_READ_WRITE_TOKEN,
            process.env.VERCEL_OIDC_TOKEN,
          ].filter((value): value is string => Boolean(value)),
          sink: {
            error: (line) => process.stderr.write(`${line}\n`),
            info: (line) => process.stderr.write(`${line}\n`),
          },
        }),
        metrics: new InMemoryOperationalMetrics(),
      });
      const [durable, readiness, runner] = await Promise.all([
        dashboardSource.read({ at: generatedAt }),
        health.readiness(),
        health.runner(),
      ]);
      return buildOperationsDashboard({
        at: generatedAt,
        durable,
        features: runtime,
        health: {
          readiness: readiness.status,
          runner: runner.status,
        },
      });
    };
    const result = await runOperatorCommand(process.argv.slice(2), {
      backupExport: async ({ outputPath, tenantId }) => {
        const archive = await backup.exportTenant(tenantId);
        const bytes = serializePortableTenantBackup(archive);
        await writeFile(outputPath, bytes, { flag: "wx" });
        return {
          artifactCount: archive.manifest.artifacts.length,
          byteCount: bytes.byteLength,
          caseCount: archive.manifest.reproductions.length,
          evidenceCount: archive.manifest.evidence.length,
          manifestSha256: archive.manifestSha256,
          portableSha256: createHash("sha256").update(bytes).digest("hex"),
        };
      },
      backupRestore: async ({ actorId, inputPath }) =>
        backup.restoreTenant({
          archive: parsePortableTenantBackup(
            Uint8Array.from(await readFile(inputPath)),
          ),
          requestedBy: actorId,
        }),
      backupVerify: async ({ inputPath }) => {
        const archive = parsePortableTenantBackup(
          Uint8Array.from(await readFile(inputPath)),
        );
        return {
          artifactCount: archive.manifest.artifacts.length,
          caseCount: archive.manifest.reproductions.length,
          evidenceCount: archive.manifest.evidence.length,
          manifestSha256: archive.manifestSha256,
          tenantId: archive.manifest.tenant.tenantId,
          verified: true,
        };
      },
      checkAlerts: async () => {
        const dashboard = await dashboardSnapshot();
        const alerts = dashboard.alerts.filter(
          ({ status }) => status === "firing",
        );
        return {
          active: alerts.length,
          alerts,
          generatedAt: dashboard.generatedAt,
          schemaVersion: dashboard.schemaVersion,
        };
      },
      dashboardSnapshot,
      executeRetention: () =>
        retention.executeNext({ at: clock.now().toISOString() }),
      listQuarantine: (input) => quarantine.listOpen(input),
      publishOutbox: () => outboxPublisher.publishBatch(),
      recoverExpiredLeases: ({ limit }) =>
        repository.recoverExpiredLeases({
          at: clock.now().toISOString(),
          limit,
        }),
      resolveQuarantine: (input) => quarantine.resolve(input),
      scheduleRetention: async ({ limit }) => ({
        scheduled: (
          await retention.scheduleDue({ at: clock.now().toISOString(), limit })
        ).length,
      }),
    });
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify(formatOperatorFailure(error))}\n`);
    process.exitCode = 1;
  } finally {
    await database?.close();
  }
}

void main();
