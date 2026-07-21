import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";

import { createGitHubServiceRegistry } from "@/github/service-registry";

describe("GitHub service registry properties", () => {
  it("never lets arbitrary execution failures poison authorization", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom("authorization", "runtime"), {
          maxLength: 30,
          minLength: 1,
        }),
        fc.string({ maxLength: 80 }),
        async (operations, failureMessage) => {
          const authorization = { tenant: "synthetic_tenant" } as const;
          const createAuthorization = vi.fn(async () => authorization);
          const createRuntime = vi.fn(async () => {
            throw new Error(failureMessage);
          });
          const registry = createGitHubServiceRegistry({
            createAuthorization,
            createRuntime,
          });

          for (const operation of operations) {
            if (operation === "authorization") {
              await expect(registry.getAuthorizationServices()).resolves.toBe(
                authorization,
              );
            } else {
              await expect(registry.getRuntimeServices()).rejects.toThrow();
            }
          }

          await expect(registry.getAuthorizationServices()).resolves.toBe(
            authorization,
          );
          expect(createAuthorization).toHaveBeenCalledTimes(1);
          expect(createRuntime.mock.calls.length).toBeLessThanOrEqual(1);
        },
      ),
      { numRuns: 300 },
    );
  });
});
