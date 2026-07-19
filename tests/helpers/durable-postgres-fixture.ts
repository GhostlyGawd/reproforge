import type {
  DurableReproductionRecord,
  QueueMessage,
} from "@/application/ports/production";
import { createCase } from "@/domain/case";
import { createJob } from "@/domain/job";

export const DURABLE_AT = "2026-07-19T20:00:00.000Z";

export function durableRecord(
  tenantId: string,
  suffix = tenantId,
): DurableReproductionRecord {
  const caseId = `case_${suffix}`;
  const jobId = `job_${suffix}`;
  const at = new Date(DURABLE_AT);
  return {
    callerId: `caller_${suffix}`,
    caseId,
    commandHash: "a".repeat(64),
    createdAt: DURABLE_AT,
    idempotencyKey: `start_${suffix}`,
    jobId,
    snapshot: {
      case: createCase(caseId, at),
      job: createJob(jobId, caseId, at),
      result: null,
      sampleId: "cli-spaces",
      schemaVersion: "2.0",
    },
    tenantId,
    updatedAt: DURABLE_AT,
    version: 1,
  };
}

export function queueMessage(
  record: DurableReproductionRecord,
  kind: QueueMessage["kind"] = "reproduction.requested",
  eventId = `event_${record.caseId}`,
): QueueMessage {
  return {
    caseId: record.caseId,
    eventId,
    jobId: record.jobId,
    kind,
    schemaVersion: "1.0",
    tenantId: record.tenantId,
  };
}
