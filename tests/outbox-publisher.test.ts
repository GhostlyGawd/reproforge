import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OutboxPublisher } from "@/application/outbox-publisher";
import type { JobQueue } from "@/application/ports/production";
import { applyPostgresMigrations } from "@/infrastructure/postgres/migrations";
import {
  PostgresDurableReproductionRepository,
  PostgresOutbox,
} from "@/infrastructure/postgres/repositories";

import { durableRecord, queueMessage } from "./helpers/durable-postgres-fixture";
import { pgliteMigrationClient } from "./helpers/pglite-migration-client";
import { pglitePostgresDatabase } from "./helpers/pglite-postgres-database";

vi.setConfig({ hookTimeout: 30_000, testTimeout: 30_000 });

describe("transactional outbox publisher", () => {
  let database: PGlite;
  let now: Date;

  beforeEach(async () => {
    database = new PGlite();
    await applyPostgresMigrations(pgliteMigrationClient(database));
    now = new Date("2026-07-20T20:00:00.000Z");
  });

  afterEach(async () => {
    await database.close();
  });

  async function harness(input: {
    maxAttempts?: number;
    queue?: JobQueue;
    suffix: string;
  }) {
    const postgres = pglitePostgresDatabase(database);
    const record = durableRecord(`tenant_${input.suffix}`, input.suffix);
    await database.query("INSERT INTO tenants (id) VALUES ($1)", [record.tenantId]);
    await new PostgresDurableReproductionRepository(postgres).reserve(record);
    const outbox = new PostgresOutbox(postgres);
    await outbox.append(queueMessage(record));
    const sent: string[] = [];
    const queue =
      input.queue ??
      ({
        send: async (message) => {
          sent.push(message.eventId);
          return { messageId: `provider_${message.eventId}` };
        },
      } satisfies JobQueue);
    const publisher = new OutboxPublisher({
      claimSeconds: 30,
      clock: { now: () => now },
      maxAttempts: input.maxAttempts ?? 3,
      maxBatchSize: 10,
      outbox,
      ownerId: `publisher_${input.suffix}`,
      queue,
    });
    return { outbox, publisher, record, sent };
  }

  it("claims, publishes with the durable event identity, and marks delivery", async () => {
    const { publisher, record, sent } = await harness({ suffix: "success" });

    await expect(publisher.publishBatch()).resolves.toEqual({
      claimed: 1,
      conflicted: 0,
      dead: 0,
      delivered: 1,
      retryScheduled: 0,
    });
    expect(sent).toEqual([`event_${record.caseId}`]);
    const rows = await database.query<{
      delivery_count: number;
      provider_message_id: string;
      status: string;
    }>(
      "SELECT status, delivery_count, provider_message_id FROM outbox_events WHERE tenant_id = $1",
      [record.tenantId],
    );
    expect(rows.rows).toEqual([
      {
        delivery_count: 1,
        provider_message_id: `provider_event_${record.caseId}`,
        status: "DELIVERED",
      },
    ]);
  });

  it("lets only one concurrent publisher own the event", async () => {
    const first = await harness({ suffix: "concurrent" });
    const second = new OutboxPublisher({
      claimSeconds: 30,
      clock: { now: () => now },
      maxAttempts: 3,
      maxBatchSize: 10,
      outbox: first.outbox,
      ownerId: "publisher_competitor",
      queue: {
        send: async (message) => {
          first.sent.push(message.eventId);
          return { messageId: `provider_${message.eventId}` };
        },
      },
    });

    const summaries = await Promise.all([
      first.publisher.publishBatch(),
      second.publishBatch(),
    ]);

    expect(summaries.reduce((total, result) => total + result.delivered, 0)).toBe(1);
    expect(first.sent).toHaveLength(1);
  });

  it("backs off deterministically and dead-letters after a bounded attempt count", async () => {
    const queue: JobQueue = {
      send: async () => {
        throw new Error("synthetic provider diagnostic that must not persist");
      },
    };
    const { publisher, record } = await harness({
      maxAttempts: 2,
      queue,
      suffix: "bounded",
    });

    await expect(publisher.publishBatch()).resolves.toMatchObject({
      dead: 0,
      retryScheduled: 1,
    });
    now = new Date("2026-07-20T20:00:06.000Z");
    await expect(publisher.publishBatch()).resolves.toMatchObject({
      dead: 1,
      retryScheduled: 0,
    });

    const rows = await database.query<{
      delivery_count: number;
      last_error_code: string;
      status: string;
    }>(
      "SELECT status, delivery_count, last_error_code FROM outbox_events WHERE tenant_id = $1",
      [record.tenantId],
    );
    expect(rows.rows).toEqual([
      {
        delivery_count: 2,
        last_error_code: "QUEUE_PUBLISH_FAILED",
        status: "DEAD",
      },
    ]);
    expect(JSON.stringify(rows.rows)).not.toContain("synthetic provider diagnostic");
  });

  it("reclaims an expired publisher claim while rejecting the stale owner", async () => {
    const { outbox } = await harness({ suffix: "claim_recovery" });
    const first = await outbox.claimPending({
      at: "2026-07-20T20:00:00.000Z",
      claimSeconds: 30,
      limit: 1,
      ownerId: "publisher_crashed",
    });
    expect(first).toHaveLength(1);
    await expect(
      outbox.claimPending({
        at: "2026-07-20T20:00:29.000Z",
        claimSeconds: 30,
        limit: 1,
        ownerId: "publisher_early",
      }),
    ).resolves.toEqual([]);
    const recovered = await outbox.claimPending({
      at: "2026-07-20T20:00:31.000Z",
      claimSeconds: 30,
      limit: 1,
      ownerId: "publisher_recovery",
    });
    expect(recovered).toMatchObject([
      { claimOwnerId: "publisher_recovery", deliveryAttempt: 2 },
    ]);
    await expect(
      outbox.markDelivered(first[0]!, {
        deliveredAt: "2026-07-20T20:00:32.000Z",
        providerMessageId: "provider_stale",
      }),
    ).resolves.toBe(false);
    await expect(
      outbox.markDelivered(recovered[0]!, {
        deliveredAt: "2026-07-20T20:00:32.000Z",
        providerMessageId: "provider_recovered",
      }),
    ).resolves.toBe(true);
  });
});
