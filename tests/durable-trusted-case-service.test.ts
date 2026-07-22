import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DurableTrustedCaseService } from "@/application/durable-trusted-case-service";
import type { QueueMessage } from "@/application/ports/production";
import { runTrustedSample } from "@/application/sample-case";
import {
  createExportBundleHandler,
  createGetReproductionHandler,
  createStartReproductionHandler,
} from "@/app/api/v2/handlers";
import { ContentAddressedArtifactStore } from "@/infrastructure/artifacts/content-addressed-store";
import { applyPostgresMigrations } from "@/infrastructure/postgres/migrations";
import {
  PostgresDurableReproductionRepository,
  PostgresOutbox,
  PostgresUnitOfWork,
} from "@/infrastructure/postgres/repositories";
import { createReproForgeMcpServer } from "@/mcp/server";

import { MemoryPrivateBlobClient } from "./helpers/memory-private-blob-client";
import { databaseClockAt } from "./helpers/database-clock";
import { pgliteMigrationClient } from "./helpers/pglite-migration-client";
import { pglitePostgresDatabase } from "./helpers/pglite-postgres-database";

vi.setConfig({ hookTimeout: 45_000, testTimeout: 45_000 });

const TENANT_ID = "tenant_trusted_provider_fixture";
const REST_CALLER = "rest:anonymous-trusted-sample";

class MonotonicClock {
  private value = Date.parse(databaseClockAt());

  now(): Date {
    this.value += 1_000;
    return new Date(this.value);
  }
}

describe("durable trusted fixture orchestration", () => {
  const databases: PGlite[] = [];

  afterEach(async () => {
    await Promise.all(databases.splice(0).map((database) => database.close()));
  });

  async function harness() {
    const database = new PGlite();
    databases.push(database);
    await applyPostgresMigrations(pgliteMigrationClient(database));
    await database.query(
      `INSERT INTO tenants (id, created_at, updated_at)
       VALUES ($1, $2, $2)`,
      [TENANT_ID, databaseClockAt(-60 * 60 * 1_000)],
    );
    const postgres = pglitePostgresDatabase(database);
    const clock = new MonotonicClock();
    const blobs = new MemoryPrivateBlobClient();
    const messages: QueueMessage[] = [];
    const executeTrustedSample = vi.fn(runTrustedSample);
    let caseSequence = 0;
    let jobSequence = 0;
    let workerSequence = 0;

    const createService = () => {
      const repository = new PostgresDurableReproductionRepository(postgres);
      return new DurableTrustedCaseService({
        artifactStore: new ContentAddressedArtifactStore(postgres, blobs, clock),
        clock,
        executeTrustedSample,
        identifiers: {
          nextCaseId: () => `case_durable_${++caseSequence}`,
          nextJobId: () => `job_durable_${++jobSequence}`,
          nextWorkerOwnerId: () => `worker_durable_${++workerSequence}`,
        },
        leaseSeconds: 90,
        outbox: new PostgresOutbox(postgres),
        outboxPolicy: {
          claimSeconds: 30,
          maxAttempts: 5,
          maxBatchSize: 25,
          ownerId: "publisher_durable_fixture",
        },
        queue: {
          send: async (message) => {
            messages.push(structuredClone(message));
            return { messageId: `provider_${message.eventId}` };
          },
        },
        repository,
        retentionDays: 30,
        tenantId: TENANT_ID,
        unitOfWork: new PostgresUnitOfWork(postgres),
      });
    };

    return {
      blobs,
      createService,
      database,
      executeTrustedSample,
      messages,
    };
  }

  it("persists one verified fixture, private bundle, and identity across an adapter restart", async () => {
    const fixture = await harness();
    const service = fixture.createService();
    const command = {
      callerId: REST_CALLER,
      idempotencyKey: "durable-provider-retry",
      sampleId: "cli-spaces" as const,
    };

    const first = await service.startTrustedReproduction(command);
    const recreated = fixture.createService();
    const retry = await recreated.startTrustedReproduction(command);

    expect(first.reused).toBe(false);
    expect(first.snapshot).toMatchObject({
      case: { state: "VERIFIED" },
      job: { attempt: 1, state: "SUCCEEDED" },
      result: { summary: { status: "VERIFIED" } },
    });
    expect(retry).toEqual({ reused: true, snapshot: first.snapshot });
    expect(fixture.executeTrustedSample).toHaveBeenCalledTimes(1);
    expect(fixture.messages).toEqual([
      {
        caseId: first.snapshot.case.id,
        eventId: `outbox_${first.snapshot.case.id}`,
        jobId: first.snapshot.job.id,
        kind: "reproduction.requested",
        schemaVersion: "1.0",
        tenantId: TENANT_ID,
      },
    ]);
    expect(JSON.stringify(fixture.messages)).not.toContain("files");
    expect(JSON.stringify(fixture.messages)).not.toContain("source");

    const counts = await fixture.database.query<{
      artifacts: string;
      cases: string;
      jobs: string;
      outbox: string;
    }>(
      `SELECT
         (SELECT count(*) FROM artifacts WHERE tenant_id = $1 AND status = 'AVAILABLE')::text AS artifacts,
         (SELECT count(*) FROM cases WHERE tenant_id = $1)::text AS cases,
         (SELECT count(*) FROM jobs WHERE tenant_id = $1)::text AS jobs,
         (SELECT count(*) FROM outbox_events WHERE tenant_id = $1 AND status = 'DELIVERED')::text AS outbox`,
      [TENANT_ID],
    );
    expect(counts.rows).toEqual([
      { artifacts: "1", cases: "1", jobs: "1", outbox: "1" },
    ]);
    expect(fixture.blobs.puts).toHaveLength(1);
  });

  it("keeps the same case, job, and bundle identity through service, REST, and MCP reads", async () => {
    const fixture = await harness();
    const service = fixture.createService();
    const start = createStartReproductionHandler(service, () => "request-start");
    const read = createGetReproductionHandler(service, () => "request-read");
    const exportBundle = createExportBundleHandler(
      service,
      () => "request-export",
    );
    const startResponse = await start(
      new Request("http://localhost/api/v2/reproductions", {
        body: JSON.stringify({ sampleId: "cli-spaces" }),
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "surface-identity",
        },
        method: "POST",
      }),
    );
    const started = await startResponse.json();
    const caseId = String(started.data.snapshot.case.id);
    const jobId = String(started.data.snapshot.job.id);
    const bundleHash = String(started.data.snapshot.result.bundle.bundleHash);

    const readResponse = await read(
      new Request(`http://localhost/api/v2/reproductions/${caseId}`),
      { params: Promise.resolve({ caseId }) },
    );
    const exportResponse = await exportBundle(
      new Request(`http://localhost/api/v2/reproductions/${caseId}/bundle`),
      { params: Promise.resolve({ caseId }) },
    );
    const readBody = await readResponse.json();
    const exportBody = await exportResponse.json();

    const server = createReproForgeMcpServer({ service });
    const client = new Client(
      { name: "durable-surface-test", version: "1.0.0" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const mcpRead = await client.callTool({
        arguments: { caseId },
        name: "get_reproduction",
      });
      const mcpExport = await client.callTool({
        arguments: { caseId },
        name: "export_repro_bundle",
      });

      expect(startResponse.status).toBe(201);
      expect(readResponse.status).toBe(200);
      expect(exportResponse.status).toBe(200);
      expect(readBody.data).toMatchObject({
        case: { id: caseId },
        job: { id: jobId },
        result: { bundle: { bundleHash, caseId } },
      });
      expect(exportBody.data).toMatchObject({
        bundle: { bundleHash, caseId },
        caseId,
      });
      expect(mcpRead.structuredContent).toMatchObject({ caseId, jobId });
      expect(mcpExport.structuredContent).toMatchObject({ bundleHash, caseId });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("preserves one durable identity for 250 generated restart/retry sequences", async () => {
    const fixture = await harness();
    const command = {
      callerId: REST_CALLER,
      idempotencyKey: "property-restart-retry",
      sampleId: "cli-spaces" as const,
    };
    const first = await fixture
      .createService()
      .startTrustedReproduction(command);

    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 8 }), async (retryCount) => {
        for (let index = 0; index < retryCount; index += 1) {
          const retried = await fixture
            .createService()
            .startTrustedReproduction(command);
          expect(retried.reused).toBe(true);
          expect(retried.snapshot.case.id).toBe(first.snapshot.case.id);
          expect(retried.snapshot.job.id).toBe(first.snapshot.job.id);
          expect(retried.snapshot.result?.bundle?.bundleHash).toBe(
            first.snapshot.result?.bundle?.bundleHash,
          );
        }
      }),
      { numRuns: 250, seed: 8_406_003 },
    );

    expect(fixture.executeTrustedSample).toHaveBeenCalledTimes(1);
    expect(fixture.messages).toHaveLength(1);
    expect(fixture.blobs.puts).toHaveLength(1);
  });
});
