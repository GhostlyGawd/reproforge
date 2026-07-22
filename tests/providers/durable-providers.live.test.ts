import { createHash, randomUUID } from "node:crypto";

import { head } from "@vercel/blob";
import { QueueClient } from "@vercel/queue";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { DurableQueueConsumer } from "@/application/durable-queue-consumer";
import {
  reserveDurableStart,
  type DurableStartInput,
} from "@/application/durable-start";
import { DurableTrustedCaseService } from "@/application/durable-trusted-case-service";
import type {
  DurableReproductionRecord,
  QueueMessage,
  TenantScope,
} from "@/application/ports/production";
import { runTrustedSample } from "@/application/sample-case";
import { createCase } from "@/domain/case";
import { createJob } from "@/domain/job";
import { ContentAddressedArtifactStore } from "@/infrastructure/artifacts/content-addressed-store";
import { VercelPrivateBlobClient } from "@/infrastructure/artifacts/vercel-private-blob-client";
import { JsonTenantBackupLogger } from "@/infrastructure/backup/observability";
import { PostgresTenantBackupService } from "@/infrastructure/backup/postgres-tenant-backup";
import {
  InMemoryOperationalMetrics,
  JsonOperationalLogger,
} from "@/infrastructure/operations/observability";
import { createRuntimeHealthService } from "@/infrastructure/operations/runtime-health";
import { applyPostgresMigrations } from "@/infrastructure/postgres/migrations";
import {
  createNeonPostgresDatabase,
  type NeonPostgresDatabase,
} from "@/infrastructure/postgres/neon-database";
import {
  PostgresDurableReproductionRepository,
  PostgresOutbox,
  PostgresUnitOfWork,
} from "@/infrastructure/postgres/repositories";
import { VercelJobQueue } from "@/infrastructure/queue/vercel-job-queue";
import { PostgresTenantDataRetention } from "@/infrastructure/retention/postgres-tenant-data-retention";

import {
  BACKUP_BODY_MARKER,
  seedVerifiedBackupTenantWithAdapters,
} from "../helpers/tenant-backup-fixture";

vi.setConfig({ hookTimeout: 120_000, testTimeout: 120_000 });

const LIVE = process.env.REPROFORGE_LIVE_PROVIDER_TESTS === "1";

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing live provider environment: ${name}`);
  return value;
}

function suffix(): string {
  return `${Date.now()}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

function databaseUrlWithSearchPath(
  connectionString: string,
  schema: string,
): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(schema)) {
    throw new Error("Invalid provider-test schema");
  }
  const url = new URL(connectionString);
  url.searchParams.set("options", `-csearch_path=${schema}`);
  return url.toString();
}

function tenantScope(tenantId: string, callerId: string): TenantScope {
  return { callerId, principalId: callerId, tenantId };
}

function liveQueue(topic: string): VercelJobQueue {
  const client = new QueueClient({ deploymentId: null, region: "iad1" });
  return new VercelJobQueue(
    { region: "iad1", retentionSeconds: 60, topic },
    {
      send: (topicName, payload, options) =>
        client.send(topicName, payload, options),
    },
  );
}

class ProviderClock {
  private value = Date.now() + 2_000;

  now(): Date {
    this.value += 1_000;
    return new Date(this.value);
  }
}

function durableInput(input: {
  at: string;
  callerId: string;
  caseId: string;
  idempotencyKey: string;
  jobId: string;
  tenantId: string;
}): DurableStartInput {
  const record: DurableReproductionRecord = {
    callerId: input.callerId,
    caseId: input.caseId,
    commandHash: "a".repeat(64),
    createdAt: input.at,
    idempotencyKey: input.idempotencyKey,
    jobId: input.jobId,
    requestedBudget: { maxToolCalls: 6, requiredRuns: 3 },
    snapshot: {
      case: createCase(input.caseId, new Date(input.at)),
      job: createJob(input.jobId, input.caseId, new Date(input.at)),
      result: null,
      sampleId: "cli-spaces",
      schemaVersion: "2.0",
    },
    tenantId: input.tenantId,
    updatedAt: input.at,
    version: 1,
  };
  return {
    auditEvent: {
      action: "case.created",
      actorId: input.callerId,
      eventId: `audit_${input.caseId}`,
      metadata: { sampleKind: "trusted-sample" },
      occurredAt: input.at,
      outcome: "success",
      targetId: input.caseId,
      targetType: "case",
      tenantId: input.tenantId,
    },
    outboxMessage: {
      caseId: input.caseId,
      eventId: `outbox_${input.caseId}`,
      jobId: input.jobId,
      kind: "reproduction.requested",
      schemaVersion: "1.0",
      tenantId: input.tenantId,
    },
    quotaReservation: {
      amount: 1,
      caseId: input.caseId,
      expiresAt: new Date(Date.parse(input.at) + 900_000).toISOString(),
      jobId: input.jobId,
      reservationId: `quota_${input.caseId}`,
      resource: "active-jobs",
      tenantId: input.tenantId,
    },
    record,
  };
}

describe.skipIf(!LIVE)("live private Blob and Vercel Queue transports", () => {
  let blobClient: VercelPrivateBlobClient;
  let blobToken: string;

  beforeAll(async () => {
    blobToken = requiredEnvironment("BLOB_READ_WRITE_TOKEN");
    requiredEnvironment("VERCEL_OIDC_TOKEN");
    blobClient = new VercelPrivateBlobClient({
      method: "read-write-token",
      token: blobToken,
    });
  });

  it("denies direct private-object access and verifies authorized round-trip deletion", async () => {
    const pathname = `provider-tests/blob-${suffix()}`;
    const bytes = new TextEncoder().encode("synthetic private provider proof");
    let etag: string | undefined;
    try {
      const stored = await blobClient.put(pathname, bytes);
      etag = stored.etag;
      const metadata = await head(pathname, { token: blobToken });
      const unauthorized = await fetch(metadata.url, { redirect: "manual" });
      const authorized = await blobClient.get(pathname, bytes.byteLength);

      expect([401, 403, 404]).toContain(unauthorized.status);
      expect(authorized?.bytes).toEqual(bytes);
      await expect(blobClient.delete(pathname, stored.etag)).resolves.toBe(true);
      etag = undefined;
      await expect(blobClient.get(pathname, bytes.byteLength)).resolves.toBeNull();
    } finally {
      const remaining = await blobClient.head(pathname).catch(() => null);
      if (remaining) {
        await blobClient.delete(pathname, etag ?? remaining.etag).catch(() => false);
      }
    }
  });

  it("accepts an identifier-only message through the live Vercel Queue service", async () => {
    const id = suffix();
    const queue = liveQueue(`reproforge-provider-${id}`);
    const message: QueueMessage = {
      caseId: `case_${id}`,
      eventId: `event_${id}`,
      jobId: `job_${id}`,
      kind: "reproduction.requested",
      schemaVersion: "1.0",
      tenantId: `tenant_${id}`,
    };

    const result = await queue.send(message);

    expect(
      result.messageId === null ||
        (typeof result.messageId === "string" && result.messageId.length > 0),
    ).toBe(true);
    expect(Object.keys(message).sort()).toEqual([
      "caseId",
      "eventId",
      "jobId",
      "kind",
      "schemaVersion",
      "tenantId",
    ]);
  });
});

describe.skipIf(!LIVE)("live durable provider composition", () => {
  let database: NeonPostgresDatabase;
  let blobClient: VercelPrivateBlobClient;

  beforeAll(async () => {
    database = createNeonPostgresDatabase(requiredEnvironment("DATABASE_URL"));
    blobClient = new VercelPrivateBlobClient({
      method: "read-write-token",
      token: requiredEnvironment("BLOB_READ_WRITE_TOKEN"),
    });
    requiredEnvironment("VERCEL_OIDC_TOKEN");
    await applyPostgresMigrations(database);
  });

  afterAll(async () => {
    await database?.close();
  });

  async function createTenant(tenantId: string): Promise<void> {
    await database.query(
      `INSERT INTO tenants (id, created_at, updated_at)
       VALUES ($1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [tenantId],
    );
  }

  async function cleanTenant(
    tenantId: string,
    callerId: string,
  ): Promise<void> {
    const at = new Date(Date.now() + 180_000).toISOString();
    const retention = new PostgresTenantDataRetention(database, blobClient);
    await retention.request({
      at,
      requestId: `delete_${createHash("sha256")
        .update(tenantId)
        .digest("hex")
        .slice(0, 40)}`,
      scheduledAt: at,
      scope: tenantScope(tenantId, callerId),
    });
    await retention.executeNext({
      at: new Date(Date.parse(at) + 1_000).toISOString(),
      ownerId: `cleanup_${createHash("sha256")
        .update(tenantId)
        .digest("hex")
        .slice(0, 40)}`,
    });
  }

  it("runs the verified fixture end to end and preserves identity after reconstruction", async () => {
    const id = suffix();
    const tenantId = `tenant_provider_${id}`;
    const callerId = `caller_provider_${id}`;
    const clock = new ProviderClock();
    const repository = new PostgresDurableReproductionRepository(database);
    const executeTrustedSample = vi.fn(runTrustedSample);
    let caseSequence = 0;
    let jobSequence = 0;
    let workerSequence = 0;
    await createTenant(tenantId);
    const createService = () =>
      new DurableTrustedCaseService({
        artifactStore: new ContentAddressedArtifactStore(
          database,
          blobClient,
          clock,
        ),
        clock,
        executeTrustedSample,
        identifiers: {
          nextCaseId: () => `case_provider_${id}_${++caseSequence}`,
          nextJobId: () => `job_provider_${id}_${++jobSequence}`,
          nextWorkerOwnerId: () => `worker_provider_${id}_${++workerSequence}`,
        },
        leaseSeconds: 90,
        outbox: new PostgresOutbox(database),
        outboxPolicy: {
          claimSeconds: 30,
          maxAttempts: 5,
          maxBatchSize: 25,
          ownerId: `publisher_provider_${id}`,
        },
        queue: liveQueue(`reproforge-provider-${id}`),
        repository,
        retentionDays: 30,
        tenantId,
        unitOfWork: new PostgresUnitOfWork(database),
      });

    try {
      const command = {
        callerId,
        idempotencyKey: `start_provider_${id}`,
        sampleId: "cli-spaces" as const,
      };
      const first = await createService().startTrustedReproduction(command);
      const retried = await createService().startTrustedReproduction(command);

      expect(first.reused).toBe(false);
      expect(first.snapshot).toMatchObject({
        case: { state: "VERIFIED" },
        job: { attempt: 1, state: "SUCCEEDED" },
        result: { summary: { status: "VERIFIED" } },
      });
      expect(retried).toEqual({ reused: true, snapshot: first.snapshot });
      expect(executeTrustedSample).toHaveBeenCalledTimes(1);

      const exported = await createService().exportReproBundle({
        callerId,
        caseId: first.snapshot.case.id,
      });
      expect(exported).toMatchObject({
        bundle: {
          bundleHash: first.snapshot.result?.bundle?.bundleHash,
          caseId: first.snapshot.case.id,
        },
        caseId: first.snapshot.case.id,
        schemaVersion: "2.0",
      });
      expect(exported.files).toHaveProperty("REPRO.md");

      const foreignRead = await repository.findByCaseId(
        tenantScope(`tenant_foreign_${id}`, callerId),
        first.snapshot.case.id,
      );
      expect(foreignRead).toBeNull();

      const duplicateConsumer = new DurableQueueConsumer({
        clock,
        leaseSeconds: 90,
        repository,
        worker: {
          execute: async () => {
            throw new Error("terminal duplicate must not execute");
          },
        },
      });
      const duplicateMessage: QueueMessage = {
        caseId: first.snapshot.case.id,
        eventId: `outbox_${first.snapshot.case.id}`,
        jobId: first.snapshot.job.id,
        kind: "reproduction.requested",
        schemaVersion: "1.0",
        tenantId,
      };
      await expect(
        duplicateConsumer.consume(duplicateMessage, `duplicate_a_${id}`),
      ).resolves.toEqual({ outcome: "ignored" });
      await expect(
        duplicateConsumer.consume(duplicateMessage, `duplicate_b_${id}`),
      ).resolves.toEqual({ outcome: "ignored" });

      const artifact = await database.query<{
        access_class: string;
        status: string;
      }>(
        `SELECT access_class, status FROM artifacts
          WHERE tenant_id = $1 AND case_id = $2 AND kind = 'bundle'`,
        [tenantId, first.snapshot.case.id],
      );
      expect(artifact.rows).toEqual([
        { access_class: "PRIVATE", status: "AVAILABLE" },
      ]);
    } finally {
      await cleanTenant(tenantId, callerId);
    }
  });

  it("uses live Postgres serialization for concurrent starts and one expired-lease recovery", async () => {
    const id = suffix();
    const tenantId = `tenant_concurrency_${id}`;
    const callerId = `caller_concurrency_${id}`;
    const at = new Date(Date.now() + 2_000).toISOString();
    const input = durableInput({
      at,
      callerId,
      caseId: `case_concurrency_${id}`,
      idempotencyKey: `start_concurrency_${id}`,
      jobId: `job_concurrency_${id}`,
      tenantId,
    });
    await createTenant(tenantId);
    try {
      const starts = await Promise.all(
        Array.from({ length: 8 }, () =>
          reserveDurableStart(new PostgresUnitOfWork(database), input),
        ),
      );
      expect(starts.filter(({ created }) => created)).toHaveLength(1);
      expect(new Set(starts.map(({ record }) => record.caseId))).toEqual(
        new Set([input.record.caseId]),
      );
      expect(new Set(starts.map(({ record }) => record.jobId))).toEqual(
        new Set([input.record.jobId]),
      );

      const repository = new PostgresDurableReproductionRepository(database);
      const lease = await repository.claimLease({
        at: new Date(Date.parse(at) + 1_000).toISOString(),
        jobId: input.record.jobId,
        leaseSeconds: 1,
        ownerId: `worker_crashed_${id}`,
        tenantId,
      });
      expect(lease).not.toBeNull();
      const recoveredAt = new Date(Date.parse(at) + 3_000).toISOString();
      await expect(
        repository.recoverExpiredLeases({ at: recoveredAt, limit: 10 }),
      ).resolves.toEqual({ cancelled: 0, exhausted: 0, requeued: 1 });
      await expect(
        repository.recoverExpiredLeases({ at: recoveredAt, limit: 10 }),
      ).resolves.toEqual({ cancelled: 0, exhausted: 0, requeued: 0 });
    } finally {
      await cleanTenant(tenantId, callerId);
    }
  });

  it("reports live durable dependencies and isolated runner ready", async () => {
    const logs: string[] = [];
    const health = createRuntimeHealthService({
      clock: { now: () => new Date() },
      environment: {
        APP_BASE_URL: "https://provider-proof.reproforge.test",
        AUTH0_CLIENT_ID: "synthetic-client-id",
        AUTH0_CLIENT_SECRET: "synthetic-client-secret",
        AUTH0_DOMAIN: "tenant.us.auth0.com",
        AUTH0_SECRET: "a".repeat(64),
        BLOB_READ_WRITE_TOKEN: requiredEnvironment("BLOB_READ_WRITE_TOKEN"),
        DATABASE_URL: requiredEnvironment("DATABASE_URL"),
        GITHUB_APP_CLIENT_ID: "Iv1.synthetic-client",
        GITHUB_APP_CLIENT_SECRET: "synthetic-client-secret-123456",
        GITHUB_APP_ID: "12345",
        GITHUB_APP_PRIVATE_KEY:
          "-----BEGIN PRIVATE KEY-----\n" +
          "a".repeat(256) +
          "\n-----END PRIVATE KEY-----",
        GITHUB_APP_SLUG: "reproforge-development",
        GITHUB_WEBHOOK_SECRET: "synthetic-webhook-secret-with-entropy",
        REPROFORGE_BASE_URL: "https://provider-proof.reproforge.test",
        REPROFORGE_OAUTH_TENANT_CLAIM:
          "https://provider-proof.reproforge.test/tenant_id",
        REPROFORGE_QUEUE_TOPIC: `reproforge-health-${suffix()}`,
        REPROFORGE_RUNTIME_MODE: "production",
      },
      logger: new JsonOperationalLogger({
        secrets: [
          requiredEnvironment("BLOB_READ_WRITE_TOKEN"),
          requiredEnvironment("DATABASE_URL"),
        ],
        sink: {
          error: (line) => logs.push(line),
          info: (line) => logs.push(line),
        },
      }),
      metrics: new InMemoryOperationalMetrics(),
    });

    await expect(health.readiness()).resolves.toMatchObject({
      checks: [
        { code: "DATABASE_READY", component: "database", status: "ready" },
        {
          code: "ARTIFACT_STORE_READY",
          component: "artifact-store",
          status: "ready",
        },
        {
          code: "QUEUE_CONFIGURATION_READY",
          component: "queue",
          status: "ready",
        },
      ],
      status: "ready",
    });
    await expect(health.runner()).resolves.toMatchObject({
      checks: [
        {
          code: "RUNNER_READY",
          component: "runner",
          status: "ready",
        },
      ],
      status: "ready",
    });
    expect(logs.join("\n")).not.toContain("postgresql://");
    expect(logs.join("\n")).not.toContain("BLOB_READ_WRITE_TOKEN");
  });

  it("exports, restores, and hash-verifies one tenant through live Neon and private Blob", async () => {
    const id = createHash("sha256").update(suffix()).digest("hex").slice(0, 16);
    const sourceSchema = `rf_source_${id}`;
    const destinationSchema = `rf_restore_${id}`;
    const tenantId = `tenant_backup_${id}`;
    const connectionString = requiredEnvironment("DATABASE_URL_UNPOOLED");
    const source = createNeonPostgresDatabase(
      databaseUrlWithSearchPath(connectionString, sourceSchema),
    );
    const destination = createNeonPostgresDatabase(
      databaseUrlWithSearchPath(connectionString, destinationSchema),
    );
    const logs: string[] = [];
    const logger = new JsonTenantBackupLogger({
      sink: {
        error: (line) => logs.push(line),
        info: (line) => logs.push(line),
      },
    });
    let objectKey: string | undefined;

    await database.execute(`CREATE SCHEMA ${sourceSchema}`);
    await database.execute(`CREATE SCHEMA ${destinationSchema}`);
    try {
      await applyPostgresMigrations(source);
      await applyPostgresMigrations(destination);
      const fixture = await seedVerifiedBackupTenantWithAdapters(
        source,
        blobClient,
        tenantId,
      );
      objectKey = fixture.artifact.objectKey;
      const sourceService = new PostgresTenantBackupService(
        source,
        blobClient,
        { now: () => new Date("2026-07-19T21:00:00.000Z") },
        logger,
      );
      const destinationService = new PostgresTenantBackupService(
        destination,
        blobClient,
        { now: () => new Date("2026-07-19T22:00:00.000Z") },
        logger,
      );

      const archive = await sourceService.exportTenant(tenantId);
      const sourceObject = await blobClient.head(objectKey);
      expect(sourceObject).not.toBeNull();
      await expect(
        blobClient.delete(objectKey, sourceObject?.etag),
      ).resolves.toBe(true);
      await expect(
        blobClient.get(objectKey, fixture.artifact.byteCount),
      ).resolves.toBeNull();

      const restored = await destinationService.restoreTenant({
        archive,
        requestedBy: `operator_${id}`,
      });
      expect(restored).toMatchObject({
        artifactCount: 1,
        caseCount: 1,
        evidenceCount: 1,
        restored: true,
        tenantId,
      });
      expect(restored.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
      await expect(
        destinationService.verifyRestore(archive),
      ).resolves.toMatchObject({ manifestSha256: restored.manifestSha256 });

      const restoredArtifact = await new ContentAddressedArtifactStore(
        destination,
        blobClient,
        { now: () => new Date("2026-07-19T22:00:01.000Z") },
      ).read(tenantScope(tenantId, fixture.callerId), fixture.artifact.artifactId);
      expect(restoredArtifact?.bytes).toEqual(fixture.body);
      expect(logs.join("\n")).not.toContain(BACKUP_BODY_MARKER);
      expect(logs.map((line) => JSON.parse(line))).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ event: "tenant-backup.exported" }),
          expect.objectContaining({ event: "tenant-backup.restored" }),
          expect.objectContaining({ event: "tenant-backup.verified" }),
        ]),
      );
    } finally {
      if (objectKey) {
        const remaining = await blobClient.head(objectKey).catch(() => null);
        if (remaining) {
          await blobClient.delete(objectKey, remaining.etag).catch(() => false);
        }
      }
      await source.close().catch(() => undefined);
      await destination.close().catch(() => undefined);
      await database.execute(`DROP SCHEMA IF EXISTS ${sourceSchema} CASCADE`);
      await database.execute(`DROP SCHEMA IF EXISTS ${destinationSchema} CASCADE`);
    }
  });
});
