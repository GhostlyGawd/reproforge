import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  formatOperatorFailure,
  runOperatorCommand,
  type OperatorCommandTools,
} from "@/application/operator-command";

const unusedTools: OperatorCommandTools = {
  backupExport: async () => ({}),
  backupRestore: async () => ({}),
  backupVerify: async () => ({}),
  executeRetention: async () => null,
  listQuarantine: async () => [],
  publishOutbox: async () => ({
    claimed: 0,
    conflicted: 0,
    dead: 0,
    delivered: 0,
    retryScheduled: 0,
  }),
  recoverExpiredLeases: async () => ({
    cancelled: 0,
    exhausted: 0,
    requeued: 0,
  }),
  resolveQuarantine: async () => ({ changed: false }),
  scheduleRetention: async () => ({ scheduled: 0 }),
};

describe("operator command properties", () => {
  it("never reflects arbitrary rejected arguments into operator failures", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 8, maxLength: 80 }).filter(
          (value) =>
            ![
              "leases:recover",
              "outbox:publish",
              "backup:export",
              "backup:restore",
              "backup:verify",
              "quarantine:list",
              "quarantine:resolve",
              "retention:execute",
              "retention:schedule",
            ].includes(value),
        ),
        async (sensitiveArgument) => {
          let failure: unknown;
          try {
            await runOperatorCommand([sensitiveArgument], unusedTools);
          } catch (error) {
            failure = formatOperatorFailure(error);
          }
          const serialized = JSON.stringify(failure);
          expect(serialized).not.toContain(sensitiveArgument);
          expect(serialized).toContain("INVALID_OPERATOR_COMMAND");
        },
      ),
      { numRuns: 500 },
    );
  });
});
