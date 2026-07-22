import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  createGitHubRuntimeFailureReporter,
  type GitHubRuntimeFailureOperation,
} from "@/github/runtime-observability";

describe("GitHub runtime observability properties", () => {
  it("never serializes thrown messages, fields, stacks, or credential-shaped values", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Za-z0-9_-]{16,48}$/),
        fc.constantFrom<GitHubRuntimeFailureOperation>(
          "install",
          "list-repositories",
        ),
        (secret, operation) => {
          const lines: string[] = [];
          const error = Object.assign(
            new Error(`postgresql://user:${secret}@private.invalid/reproforge`),
            {
              code: `ghp_${secret}`,
              fields: [secret],
              stack: `Bearer ${secret}`,
            },
          );
          const report = createGitHubRuntimeFailureReporter({
            clock: { now: () => new Date("2026-07-21T22:50:00.000Z") },
            sink: { error: (line) => lines.push(line) },
          });

          report(operation, error);

          expect(lines).toHaveLength(1);
          expect(lines[0]).not.toContain(secret);
          expect(JSON.parse(lines[0] ?? "{}")).toEqual({
            at: "2026-07-21T22:50:00.000Z",
            code: "GITHUB_DEPENDENCY_UNAVAILABLE",
            event: "github.runtime.failure",
            operation,
            schemaVersion: "1.0",
          });
        },
      ),
      { numRuns: 300 },
    );
  });

  it.each([
    "GITHUB_RUNTIME_UNAVAILABLE",
    "INVALID_GITHUB_CONFIGURATION",
    "INVALID_RUNTIME_CONFIGURATION",
    "WEB_PRINCIPAL_UNAVAILABLE",
  ] as const)("preserves the allowlisted stable code %s", (code) => {
    const lines: string[] = [];
    const report = createGitHubRuntimeFailureReporter({
      clock: { now: () => new Date("2026-07-21T22:50:00.000Z") },
      sink: { error: (line) => lines.push(line) },
    });

    report("install", Object.assign(new Error("private detail"), { code }));

    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ code });
    expect(lines[0]).not.toContain("private detail");
  });
});
