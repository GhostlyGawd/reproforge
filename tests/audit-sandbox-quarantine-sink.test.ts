import { describe, expect, it, vi } from "vitest";

import { AuditSandboxQuarantineSink } from "@/infrastructure/execution/audit-sandbox-quarantine-sink";

describe("sandbox quarantine audit sink", () => {
  it("records a sanitized tenant-scoped cleanup alert", async () => {
    const append = vi.fn(async () => undefined);
    const sink = new AuditSandboxQuarantineSink(
      { append },
      { now: () => new Date("2026-07-21T18:00:00.000Z") },
    );

    await sink.record({
      actorId: "principal_quarantine",
      attemptId: "job_quarantine.attempt-2",
      providerResourceId: "sbx_quarantine",
      reason: "cleanup-failed",
      resourceType: "sandbox",
      tenantId: "tenant_quarantine",
    });

    expect(append).toHaveBeenCalledOnce();
    expect(append).toHaveBeenCalledWith({
      action: "sandbox.cleanup-quarantined",
      actorId: "principal_quarantine",
      eventId: expect.stringMatching(/^audit_quarantine_[a-f0-9]{48}$/),
      metadata: {
        providerResourceId: "sbx_quarantine",
        reason: "cleanup-failed",
        resourceType: "sandbox",
      },
      occurredAt: "2026-07-21T18:00:00.000Z",
      outcome: "failure",
      targetId: "job_quarantine.attempt-2",
      targetType: "job",
      tenantId: "tenant_quarantine",
    });
  });

  it("rejects unscoped records before audit persistence", async () => {
    const append = vi.fn(async () => undefined);
    const sink = new AuditSandboxQuarantineSink({ append });

    await expect(
      sink.record({
        attemptId: "job_unscoped.attempt-1",
        providerResourceId: "sbx_unscoped",
        reason: "cleanup-failed",
        resourceType: "sandbox",
      }),
    ).rejects.toThrow();
    expect(append).not.toHaveBeenCalled();
  });
});
