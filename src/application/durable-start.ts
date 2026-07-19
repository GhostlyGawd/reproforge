import {
  auditEventSchema,
  queueMessageSchema,
  quotaReservationSchema,
  tenantScopeSchema,
  type AuditEvent,
  type DurableReproductionRecord,
  type DurableReservationResult,
  type QueueMessage,
  type QuotaReservation,
  type UnitOfWork,
} from "@/application/ports/production";
import { reproductionSnapshotSchema } from "@/application/reproduction-contracts";

export type DurableStartInput = {
  auditEvent: AuditEvent;
  outboxMessage: QueueMessage;
  quotaReservation: QuotaReservation;
  record: DurableReproductionRecord;
};

export class DurableStartError extends Error {
  constructor(
    readonly code:
      | "IDEMPOTENCY_CONFLICT"
      | "INVALID_START_INPUT"
      | "QUOTA_EXCEEDED",
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "DurableStartError";
  }
}

function validateStartInput(input: DurableStartInput): DurableStartInput {
  const record = input.record;
  try {
    tenantScopeSchema.parse({
      callerId: record.callerId,
      principalId: record.callerId,
      tenantId: record.tenantId,
    });
    reproductionSnapshotSchema.parse(record.snapshot);
    auditEventSchema.parse(input.auditEvent);
    queueMessageSchema.parse(input.outboxMessage);
    quotaReservationSchema.parse(input.quotaReservation);
  } catch {
    throw new DurableStartError(
      "INVALID_START_INPUT",
      "The durable start request is invalid",
      false,
    );
  }

  const aligned =
    record.caseId === record.snapshot.case.id &&
    record.jobId === record.snapshot.job.id &&
    record.caseId === record.snapshot.job.caseId &&
    input.auditEvent.tenantId === record.tenantId &&
    input.auditEvent.targetId === record.caseId &&
    input.outboxMessage.tenantId === record.tenantId &&
    input.outboxMessage.caseId === record.caseId &&
    input.outboxMessage.jobId === record.jobId &&
    input.quotaReservation.tenantId === record.tenantId &&
    input.quotaReservation.caseId === record.caseId &&
    input.quotaReservation.jobId === record.jobId;
  if (!aligned) {
    throw new DurableStartError(
      "INVALID_START_INPUT",
      "The durable start request identities do not align",
      false,
    );
  }
  return input;
}

export async function reserveDurableStart(
  unitOfWork: UnitOfWork,
  rawInput: DurableStartInput,
): Promise<DurableReservationResult> {
  const input = validateStartInput(rawInput);
  return unitOfWork.run(async (ports) => {
    const reservation = await ports.reproductions.reserve(input.record);
    if (!reservation.created) {
      if (reservation.record.commandHash !== input.record.commandHash) {
        throw new DurableStartError(
          "IDEMPOTENCY_CONFLICT",
          "The idempotency key was already used for a different request",
          false,
        );
      }
      return reservation;
    }

    if (!(await ports.quotas.reserve(input.quotaReservation))) {
      throw new DurableStartError(
        "QUOTA_EXCEEDED",
        "The tenant does not have enough available quota",
        false,
      );
    }
    await ports.audit.append(input.auditEvent);
    await ports.outbox.append(input.outboxMessage);
    return reservation;
  });
}
