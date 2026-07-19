import {
  queueMessageSchema,
  type DurableReproductionRecord,
  type DurableReproductionRepository,
  type JobLease,
  type QueueMessage,
} from "@/application/ports/production";

export type DurableWorker = Readonly<{
  execute(input: {
    lease: JobLease;
    message: QueueMessage;
    record: DurableReproductionRecord;
  }): Promise<DurableReproductionRecord>;
}>;

export type DurableQueueConsumeResult = Readonly<{
  attempt?: number;
  outcome: "completed" | "exhausted" | "ignored" | "requeued";
}>;

type DurableQueueConsumerDependencies = Readonly<{
  clock: { now(): Date };
  leaseSeconds: number;
  repository: DurableReproductionRepository;
  worker: DurableWorker;
}>;

function retryAt(now: Date, attempt: number): string {
  const seconds = Math.min(300, 5 * 2 ** Math.max(0, attempt - 1));
  return new Date(now.getTime() + seconds * 1_000).toISOString();
}

export class DurableQueueConsumer {
  constructor(private readonly dependencies: DurableQueueConsumerDependencies) {
    if (
      !Number.isInteger(dependencies.leaseSeconds) ||
      dependencies.leaseSeconds < 1 ||
      dependencies.leaseSeconds > 3_600
    ) {
      throw new Error("Invalid durable queue lease policy");
    }
  }

  async consume(
    rawMessage: QueueMessage,
    ownerId: string,
  ): Promise<DurableQueueConsumeResult> {
    const message = queueMessageSchema.parse(rawMessage);
    if (
      message.kind !== "reproduction.requested" &&
      message.kind !== "reproduction.recovery-requested"
    ) {
      return { outcome: "ignored" };
    }
    const at = this.dependencies.clock.now();
    const lease = await this.dependencies.repository.claimLease({
      at: at.toISOString(),
      jobId: message.jobId,
      leaseSeconds: this.dependencies.leaseSeconds,
      ownerId,
      tenantId: message.tenantId,
    });
    if (!lease) return { outcome: "ignored" };
    const record = await this.dependencies.repository.findByLease(lease);
    if (!record || record.caseId !== message.caseId) {
      throw new Error("Claimed queue work was unavailable");
    }

    let completed: DurableReproductionRecord;
    try {
      completed = await this.dependencies.worker.execute({
        lease,
        message,
        record,
      });
    } catch {
      const failedAt = this.dependencies.clock.now();
      const disposition = await this.dependencies.repository.failLease(lease, {
        at: failedAt.toISOString(),
        code: "DURABLE_WORKER_FAILED",
        nextAttemptAt: retryAt(failedAt, lease.attempt),
        retryable: true,
      });
      return { attempt: lease.attempt, outcome: disposition };
    }

    await this.dependencies.repository.completeLease(lease, completed);
    return { attempt: lease.attempt, outcome: "completed" };
  }
}
