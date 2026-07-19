import type {
  JobQueue,
  Outbox,
  OutboxClaim,
} from "@/application/ports/production";

export type OutboxPublishSummary = Readonly<{
  claimed: number;
  conflicted: number;
  dead: number;
  delivered: number;
  retryScheduled: number;
}>;

type OutboxPublisherDependencies = Readonly<{
  claimSeconds: number;
  clock: { now(): Date };
  maxAttempts: number;
  maxBatchSize: number;
  outbox: Outbox;
  ownerId: string;
  queue: JobQueue;
}>;

function delaySeconds(attempt: number): number {
  return Math.min(300, 5 * 2 ** Math.max(0, attempt - 1));
}

function nextAttemptAt(claim: OutboxClaim, failedAt: Date): string {
  return new Date(
    failedAt.getTime() + delaySeconds(claim.deliveryAttempt) * 1_000,
  ).toISOString();
}

export class OutboxPublisher {
  constructor(private readonly dependencies: OutboxPublisherDependencies) {
    if (
      !Number.isInteger(dependencies.claimSeconds) ||
      dependencies.claimSeconds < 1 ||
      dependencies.claimSeconds > 3_600 ||
      !Number.isInteger(dependencies.maxAttempts) ||
      dependencies.maxAttempts < 1 ||
      dependencies.maxAttempts > 32 ||
      !Number.isInteger(dependencies.maxBatchSize) ||
      dependencies.maxBatchSize < 1 ||
      dependencies.maxBatchSize > 1_000
    ) {
      throw new Error("Invalid outbox publisher policy");
    }
  }

  async publishBatch(): Promise<OutboxPublishSummary> {
    const claimedAt = this.dependencies.clock.now();
    const claims = await this.dependencies.outbox.claimPending({
      at: claimedAt.toISOString(),
      claimSeconds: this.dependencies.claimSeconds,
      limit: this.dependencies.maxBatchSize,
      ownerId: this.dependencies.ownerId,
    });
    const summary = {
      claimed: claims.length,
      conflicted: 0,
      dead: 0,
      delivered: 0,
      retryScheduled: 0,
    };

    for (const claim of claims) {
      try {
        const result = await this.dependencies.queue.send(claim.message);
        const delivered = await this.dependencies.outbox.markDelivered(claim, {
          deliveredAt: this.dependencies.clock.now().toISOString(),
          providerMessageId: result.messageId,
        });
        if (delivered) summary.delivered += 1;
        else summary.conflicted += 1;
      } catch {
        const failedAt = this.dependencies.clock.now();
        const disposition = await this.dependencies.outbox.recordFailure(claim, {
          errorCode: "QUEUE_PUBLISH_FAILED",
          failedAt: failedAt.toISOString(),
          maxAttempts: this.dependencies.maxAttempts,
          nextAttemptAt: nextAttemptAt(claim, failedAt),
        });
        if (disposition === "dead") summary.dead += 1;
        else if (disposition === "retry") summary.retryScheduled += 1;
        else summary.conflicted += 1;
      }
    }
    return summary;
  }
}
