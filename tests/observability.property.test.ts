import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { JsonOperationalLogger } from "@/infrastructure/operations/observability";

describe("structured observability properties", () => {
  it("redacts every registered and credential-shaped value over 250 generated events", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Za-z0-9_-]{16,48}$/),
        fc.constantFrom("sk-", "ghp_", "bearer_"),
        (secret, prefix) => {
          const credential = `${prefix}${secret}`;
          const lines: string[] = [];
          const logger = new JsonOperationalLogger({
            secrets: [secret, credential],
            sink: {
              error: (line) => lines.push(line),
              info: (line) => lines.push(line),
            },
          });

          logger.emit({
            at: "2026-07-19T20:00:00.000Z",
            caseId: `case_${credential}`,
            code: "DEPENDENCY_UNAVAILABLE",
            component: "database",
            durationMs: 12,
            event: "health.check",
            level: "error",
            outcome: "unavailable",
            requestId: `request_${secret}`,
          });

          expect(lines).toHaveLength(1);
          expect(lines[0]).not.toContain(secret);
          expect(lines[0]).not.toContain(credential);
          expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
            caseId: "case_redacted",
            requestId: "request_redacted",
          });
        },
      ),
      { numRuns: 250 },
    );
  });

  it("never serializes unknown payload, error, source, or credential fields", () => {
    const lines: string[] = [];
    const logger = new JsonOperationalLogger({
      sink: {
        error: (line) => lines.push(line),
        info: (line) => lines.push(line),
      },
    });

    logger.emit({
      at: "2026-07-19T20:00:00.000Z",
      code: "DEPENDENCY_UNAVAILABLE",
      component: "queue",
      durationMs: 4,
      error: new Error("synthetic secret"),
      event: "health.check",
      level: "error",
      outcome: "unavailable",
      payload: { source: "private source", token: "synthetic" },
    } as never);

    expect(JSON.parse(lines[0] ?? "{}")).toEqual({
      at: "2026-07-19T20:00:00.000Z",
      code: "DEPENDENCY_UNAVAILABLE",
      component: "queue",
      durationMs: 4,
      event: "health.check",
      level: "error",
      outcome: "unavailable",
      schemaVersion: "1.0",
    });
  });
});
