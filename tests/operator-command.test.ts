import { describe, expect, it, vi } from "vitest";

import {
  OperatorCommandError,
  formatOperatorFailure,
  runOperatorCommand,
  type OperatorCommandTools,
} from "@/application/operator-command";

function tools(): OperatorCommandTools {
  return {
    listQuarantine: vi.fn().mockResolvedValue([
      {
        attemptId: "attempt_1",
        providerResourceId: "sbx_1",
        quarantinedAt: "2026-07-20T20:00:00.000Z",
        resourceType: "sandbox",
        tenantId: "tenant_1",
      },
    ]),
    publishOutbox: vi.fn().mockResolvedValue({
      claimed: 1,
      conflicted: 0,
      dead: 0,
      delivered: 1,
      retryScheduled: 0,
    }),
    recoverExpiredLeases: vi.fn().mockResolvedValue({
      cancelled: 0,
      exhausted: 0,
      requeued: 1,
    }),
    resolveQuarantine: vi.fn().mockResolvedValue({ changed: true }),
  };
}

describe("operator command", () => {
  it("recovers bounded expired leases and publishes their durable intents", async () => {
    const operations = tools();

    await expect(
      runOperatorCommand(["leases:recover", "--limit", "25"], operations),
    ).resolves.toEqual({
      command: "leases:recover",
      result: {
        leaseRecovery: { cancelled: 0, exhausted: 0, requeued: 1 },
        outboxPublish: {
          claimed: 1,
          conflicted: 0,
          dead: 0,
          delivered: 1,
          retryScheduled: 0,
        },
      },
    });
    expect(operations.recoverExpiredLeases).toHaveBeenCalledWith({ limit: 25 });
    expect(operations.publishOutbox).toHaveBeenCalledOnce();
  });

  it("publishes due outbox retries without manufacturing a new case", async () => {
    const operations = tools();

    await expect(
      runOperatorCommand(["outbox:publish"], operations),
    ).resolves.toMatchObject({
      command: "outbox:publish",
      result: { delivered: 1 },
    });
    expect(operations.publishOutbox).toHaveBeenCalledOnce();
    expect(operations.recoverExpiredLeases).not.toHaveBeenCalled();
  });

  it("lists and resolves only an exact quarantined provider resource", async () => {
    const operations = tools();

    await expect(
      runOperatorCommand(
        ["quarantine:list", "--limit", "10"],
        operations,
      ),
    ).resolves.toMatchObject({
      command: "quarantine:list",
      result: [{ providerResourceId: "sbx_1" }],
    });
    await expect(
      runOperatorCommand(
        [
          "quarantine:resolve",
          "--tenant-id",
          "tenant_1",
          "--attempt-id",
          "attempt_1",
          "--provider-resource-id",
          "sbx_1",
          "--resource-type",
          "sandbox",
          "--actor-id",
          "operator_1",
        ],
        operations,
      ),
    ).resolves.toEqual({
      command: "quarantine:resolve",
      result: { changed: true },
    });
    expect(operations.listQuarantine).toHaveBeenCalledWith({ limit: 10 });
    expect(operations.resolveQuarantine).toHaveBeenCalledWith({
      actorId: "operator_1",
      attemptId: "attempt_1",
      providerResourceId: "sbx_1",
      resourceType: "sandbox",
      tenantId: "tenant_1",
    });
  });

  it.each([
    { argv: [] },
    { argv: ["unknown"] },
    { argv: ["leases:recover", "--limit", "0"] },
    { argv: ["leases:recover", "--limit", "2", "--limit", "3"] },
    { argv: ["outbox:publish", "--token", "never-print-this"] },
    { argv: ["quarantine:resolve", "--tenant-id", "tenant_1"] },
  ])("fails closed with stable, sanitized errors for %#", async ({ argv }) => {
    await expect(runOperatorCommand(argv, tools())).rejects.toBeInstanceOf(
      OperatorCommandError,
    );
    try {
      await runOperatorCommand(argv, tools());
    } catch (error) {
      const failure = JSON.stringify(formatOperatorFailure(error));
      expect(failure).toBe(
        '{"ok":false,"error":{"code":"INVALID_OPERATOR_COMMAND","message":"The operator command is invalid"}}',
      );
      expect(failure).not.toContain("never-print-this");
    }
  });
});
