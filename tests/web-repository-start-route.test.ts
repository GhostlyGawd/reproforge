import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";

import type { RepositoryOperations } from "@/application/repository-operations";
import { createWebRepositoryStartHandler } from "@/github/repository-start-route";

const baseUrl = "https://reproforge.example/";
const principal = {
  callerId: "principal_web_start",
  principalId: "principal_web_start",
  tenantId: "tenant_web_start",
};

function form(overrides: Record<string, string> = {}) {
  return new URLSearchParams({
    commitSha: "a".repeat(40),
    controlScript: "test:control",
    expectedExitCode: "1",
    failureOutput: "REPROFORGE_CANARY_FAILURE",
    failureStream: "stderr",
    idempotencyKey: "web-start-idempotency",
    issueNumber: "13",
    issueTitle: "Deterministic repository failure",
    nodeVersion: "24",
    reproductionScript: "test:reproduce",
    repositoryId: "repository_42",
    ...overrides,
  });
}

function request(body = form(), origin = baseUrl) {
  return new Request(`${baseUrl}api/repositories/reproductions`, {
    body,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: origin,
    },
    method: "POST",
  });
}

function operations(start = vi.fn()) {
  return {
    startRepositoryReproduction: start,
  } as unknown as Pick<RepositoryOperations, "startRepositoryReproduction">;
}

describe("authenticated web repository start", () => {
  it("maps a same-origin form to the strict repository command and redirects to durable progress", async () => {
    const start = vi.fn(async () => ({
      reused: false,
      snapshot: {
        case: { id: "case_web_repository" },
      },
    }));
    const response = await createWebRepositoryStartHandler({
      actor: async () => principal,
      baseUrl,
      operations: operations(start),
    })(request());

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      `${baseUrl}cases/case_web_repository`,
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(start).toHaveBeenCalledWith(principal, {
      budget: { maxToolCalls: 6, requiredRuns: 3 },
      idempotencyKey: "web-start-idempotency",
      source: {
        commitSha: "a".repeat(40),
        executionProfile: {
          controlScript: "test:control",
          ecosystem: "node",
          lockfile: "package-lock.json",
          nodeVersion: "24",
          packageManager: "npm",
          reproductionScript: "test:reproduce",
        },
        failureOracle: {
          id: expect.stringMatching(/^web-output-v1-[a-f0-9]{16}$/),
          root: {
            children: [
              { expected: 1, type: "exit_code" },
              {
                stream: "stderr",
                type: "output_contains",
                value: "REPROFORGE_CANARY_FAILURE",
              },
            ],
            type: "all",
          },
          version: 1,
        },
        issueEvidence: {
          number: 13,
          title: "Deterministic repository failure",
        },
        kind: "github",
        repositoryId: "repository_42",
      },
    });
  });

  it("redirects a signed-out caller to login without touching repository state", async () => {
    const start = vi.fn();
    const response = await createWebRepositoryStartHandler({
      actor: async () => null,
      baseUrl,
      operations: operations(start),
    })(request());

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      `${baseUrl}auth/login?returnTo=%2Frepositories`,
    );
    expect(start).not.toHaveBeenCalled();
  });

  it("rejects a cross-origin submission before parsing or starting work", async () => {
    const start = vi.fn();
    const response = await createWebRepositoryStartHandler({
      actor: async () => principal,
      baseUrl,
      operations: operations(start),
    })(request(form(), "https://attacker.example/"));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      `${baseUrl}repositories?start=invalid`,
    );
    expect(start).not.toHaveBeenCalled();
  });

  it("rejects 500 generated unsafe script names without starting work", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc
          .string({ minLength: 1, maxLength: 32 })
          .filter((value) => !/^[A-Za-z0-9][A-Za-z0-9:._/-]*$/.test(value)),
        async (unsafeScript) => {
          const start = vi.fn();
          const response = await createWebRepositoryStartHandler({
            actor: async () => principal,
            baseUrl,
            operations: operations(start),
          })(request(form({ reproductionScript: unsafeScript })));
          expect(response.status).toBe(303);
          expect(response.headers.get("location")).toBe(
            `${baseUrl}repositories?start=invalid`,
          );
          expect(start).not.toHaveBeenCalled();
        },
      ),
      { numRuns: 500, seed: 8407001 },
    );
  });
});
