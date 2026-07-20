import type { QueueMessage } from "@/application/ports/production";
import { getDefaultGitHubServices } from "@/github/default-services";
import { createVercelQueueConsumerHandler } from "@/infrastructure/queue/vercel-job-queue";

export const runtime = "nodejs";
export const maxDuration = 900;

const consumer = {
  consume: async (message: QueueMessage, ownerId: string) =>
    (await getDefaultGitHubServices()).queueConsumer.consume(message, ownerId),
};

export const POST = createVercelQueueConsumerHandler(consumer, {
  maxProviderDeliveries: 5,
  visibilityTimeoutSeconds: 1_200,
}) as (request: Request) => Promise<Response>;
