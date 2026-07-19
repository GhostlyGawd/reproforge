import { createHash } from "node:crypto";

import {
  handleCallback,
  send,
  type MessageMetadata,
  type RetryDirective,
  type SendOptions,
} from "@vercel/queue";

import {
  queueMessageSchema,
  type JobQueue,
  type QueueMessage,
} from "@/application/ports/production";

type QueueSend = (
  topic: string,
  payload: QueueMessage,
  options: SendOptions & { region?: string },
) => Promise<{ messageId: string | null }>;

type QueueHandlerOptions = {
  retry?: (
    error: unknown,
    metadata: Pick<MessageMetadata, "deliveryCount">,
  ) => RetryDirective | undefined;
  visibilityTimeoutSeconds?: number;
};

type QueueHandleCallback = (
  handler: (
    message: unknown,
    metadata: Pick<
      MessageMetadata,
      "consumerGroup" | "deliveryCount" | "messageId"
    >,
  ) => Promise<void>,
  options: QueueHandlerOptions,
) => unknown;

export type VercelJobQueueOptions = Readonly<{
  region: string;
  retentionSeconds: number;
  topic: string;
}>;

export class InvalidQueuePayloadError extends Error {
  readonly code = "INVALID_QUEUE_PAYLOAD";

  constructor() {
    super("The queue payload did not match the identifier-only contract");
    this.name = "InvalidQueuePayloadError";
  }
}

export class VercelJobQueue implements JobQueue {
  constructor(
    private readonly options: VercelJobQueueOptions,
    private readonly operations: { send: QueueSend } = { send },
  ) {
    if (
      !/^[A-Za-z0-9_-]+$/.test(options.topic) ||
      options.topic.length > 128 ||
      options.region.length < 1 ||
      !Number.isInteger(options.retentionSeconds) ||
      options.retentionSeconds < 60 ||
      options.retentionSeconds > 604_800
    ) {
      throw new Error("Invalid Vercel Queue configuration");
    }
  }

  async send(message: QueueMessage): Promise<{ messageId: string | null }> {
    const parsed = queueMessageSchema.parse(message);
    return this.operations.send(this.options.topic, parsed, {
      idempotencyKey: parsed.eventId,
      region: this.options.region,
      retentionSeconds: this.options.retentionSeconds,
    });
  }
}

function workerOwnerId(
  metadata: Pick<
    MessageMetadata,
    "consumerGroup" | "deliveryCount" | "messageId"
  >,
): string {
  return `worker_${createHash("sha256")
    .update(
      `${metadata.consumerGroup}:${metadata.messageId}:${metadata.deliveryCount}`,
    )
    .digest("hex")
    .slice(0, 32)}`;
}

export function createVercelQueueConsumerHandler(
  consumer: {
    consume(message: QueueMessage, ownerId: string): Promise<unknown>;
  },
  options: {
    handleCallback?: QueueHandleCallback;
    maxProviderDeliveries: number;
    visibilityTimeoutSeconds: number;
  },
): unknown {
  if (
    !Number.isInteger(options.maxProviderDeliveries) ||
    options.maxProviderDeliveries < 1 ||
    options.maxProviderDeliveries > 32 ||
    !Number.isInteger(options.visibilityTimeoutSeconds) ||
    options.visibilityTimeoutSeconds < 1 ||
    options.visibilityTimeoutSeconds > 3_600
  ) {
    throw new Error("Invalid Vercel Queue consumer policy");
  }
  const callback = options.handleCallback ?? (handleCallback as QueueHandleCallback);
  return callback(
    async (rawMessage, metadata) => {
      const parsed = queueMessageSchema.safeParse(rawMessage);
      if (!parsed.success) throw new InvalidQueuePayloadError();
      const message = parsed.data;
      await consumer.consume(message, workerOwnerId(metadata));
    },
    {
      retry: (_error, metadata) =>
        _error instanceof InvalidQueuePayloadError &&
        metadata.deliveryCount >= options.maxProviderDeliveries
          ? { acknowledge: true }
          : {
              afterSeconds: Math.min(
                300,
                5 * 2 ** Math.max(0, metadata.deliveryCount),
              ),
            },
      visibilityTimeoutSeconds: options.visibilityTimeoutSeconds,
    },
  );
}
