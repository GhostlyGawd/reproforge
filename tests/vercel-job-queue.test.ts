import { describe, expect, it, vi } from "vitest";

import type { QueueMessage } from "@/application/ports/production";
import {
  InvalidQueuePayloadError,
  VercelJobQueue,
  createVercelQueueConsumerHandler,
} from "@/infrastructure/queue/vercel-job-queue";

const message: QueueMessage = {
  caseId: "case_queue",
  eventId: "event_queue",
  jobId: "job_queue",
  kind: "reproduction.requested",
  schemaVersion: "1.0",
  tenantId: "tenant_queue",
};

describe("Vercel Queues adapter", () => {
  it("publishes identifier-only work with provider deduplication and bounded retention", async () => {
    const send = vi.fn(async () => ({ messageId: "msg_provider" }));
    const queue = new VercelJobQueue(
      {
        region: "iad1",
        retentionSeconds: 604_800,
        topic: "reproforge-jobs-v1",
      },
      { send },
    );

    await expect(queue.send(message)).resolves.toEqual({
      messageId: "msg_provider",
    });
    expect(send).toHaveBeenCalledWith("reproforge-jobs-v1", message, {
      idempotencyKey: message.eventId,
      region: "iad1",
      retentionSeconds: 604_800,
    });
  });

  it("builds an auto-renewing push consumer with bounded poison retries", async () => {
    const consume = vi.fn(async () => ({ outcome: "ignored" as const }));
    const handleCallback = vi.fn((handler, options) => ({ handler, options }));
    const route = createVercelQueueConsumerHandler(
      { consume },
      {
        handleCallback,
        maxProviderDeliveries: 5,
        visibilityTimeoutSeconds: 600,
      },
    ) as unknown as {
      handler: (
        value: unknown,
        metadata: { consumerGroup: string; deliveryCount: number; messageId: string },
      ) => Promise<void>;
      options: {
        retry: (
          error: unknown,
          metadata: { deliveryCount: number },
        ) => { acknowledge: true } | { afterSeconds: number };
        visibilityTimeoutSeconds: number;
      };
    };

    await route.handler(message, {
      consumerGroup: "reproforge-worker",
      deliveryCount: 1,
      messageId: "message_1",
    });
    await expect(
      route.handler(
        { ...message, token: "synthetic-provider-secret" },
        {
          consumerGroup: "reproforge-worker",
          deliveryCount: 5,
          messageId: "message_poison",
        },
      ),
    ).rejects.toBeInstanceOf(InvalidQueuePayloadError);

    expect(consume).toHaveBeenCalledWith(
      message,
      expect.stringMatching(/^worker_[a-f0-9]{32}$/),
    );
    expect(route.options.visibilityTimeoutSeconds).toBe(600);
    expect(route.options.retry(new Error("transient"), { deliveryCount: 2 })).toEqual({
      afterSeconds: 20,
    });
    expect(
      route.options.retry(new InvalidQueuePayloadError(), { deliveryCount: 5 }),
    ).toEqual({ acknowledge: true });
    expect(
      route.options.retry(new Error("database unavailable"), { deliveryCount: 5 }),
    ).toEqual({ afterSeconds: 160 });
  });
});
