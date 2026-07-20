import { randomUUID } from "node:crypto";

import {
  formatOperatorFailure,
  runOperatorCommand,
} from "@/application/operator-command";
import { OutboxPublisher } from "@/application/outbox-publisher";
import { getRuntimeConfig } from "@/config/runtime";
import { PostgresSandboxQuarantineOperator } from "@/infrastructure/operations/postgres-sandbox-quarantine-operator";
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
    const result = await runOperatorCommand(process.argv.slice(2), {
      listQuarantine: (input) => quarantine.listOpen(input),
      publishOutbox: () => outboxPublisher.publishBatch(),
      recoverExpiredLeases: ({ limit }) =>
        repository.recoverExpiredLeases({
          at: clock.now().toISOString(),
          limit,
        }),
      resolveQuarantine: (input) => quarantine.resolve(input),
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
