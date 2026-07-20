import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  buildOperationsDashboard,
  operationsDashboardSchema,
} from "@/application/operations-dashboard";

const count = fc.integer({ min: 0, max: 1_000_000 });
const age = fc.option(fc.integer({ min: 0, max: 86_400_000 }), {
  nil: null,
});

describe("operations dashboard properties", () => {
  it("keeps 500 generated metric sets bounded, deterministic, and schema-valid", () => {
    fc.assert(
      fc.property(
        fc.record({
          cancelled: count,
          dead: count,
          deletionFailed: count,
          deletionPending: count,
          disablePrivateRepositories: fc.boolean(),
          disableRepositoryStarts: fc.boolean(),
          expiredLeases: count,
          failed: count,
          oldestOutbox: age,
          oldestQueued: age,
          pending: count,
          quarantinedResources: count,
          queued: count,
          readiness: fc.constantFrom("ready" as const, "unavailable" as const),
          running: count,
          runner: fc.constantFrom("ready" as const, "unavailable" as const),
          succeeded: count,
        }),
        (input) => {
          const build = () =>
            buildOperationsDashboard({
              at: "2026-07-20T23:10:00.000Z",
              durable: {
                deletions: {
                  failed: input.deletionFailed,
                  pending: input.deletionPending,
                },
                jobs: {
                  cancelled: input.cancelled,
                  expiredLeases: input.expiredLeases,
                  failed: input.failed,
                  oldestQueuedAgeSeconds: input.oldestQueued,
                  queued: input.queued,
                  running: input.running,
                  succeeded: input.succeeded,
                },
                outbox: {
                  dead: input.dead,
                  oldestPendingAgeSeconds: input.oldestOutbox,
                  pending: input.pending,
                },
                quarantinedResources: input.quarantinedResources,
              },
              features: {
                disablePrivateRepositories:
                  input.disablePrivateRepositories,
                disableRepositoryStarts: input.disableRepositoryStarts,
                disabledExecutionProfiles: [],
              },
              health: {
                readiness: input.readiness,
                runner: input.runner,
              },
            });
          const one = build();

          expect(operationsDashboardSchema.parse(one)).toEqual(one);
          expect(build()).toEqual(one);
          expect(one.alerts).toHaveLength(8);
          expect(new Set(one.alerts.map(({ code }) => code)).size).toBe(8);
        },
      ),
      { numRuns: 500 },
    );
  });
});
