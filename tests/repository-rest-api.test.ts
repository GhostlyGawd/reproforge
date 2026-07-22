import { describe, expect, it, vi } from "vitest";

import type { RepositoryOperations } from "@/application/repository-operations";
import {
  createCancelRepositoryReproductionHandler,
  createExportRepositoryBundleHandler,
  createGetRepositoryReproductionHandler,
  createListAuthorizedRepositoriesHandler,
  createStartRepositoryReproductionHandler,
  type RepositoryApiAuthorizer,
} from "@/app/api/v2/repository-handlers";
import { createCase } from "@/domain/case";
import { createJob } from "@/domain/job";

const principal = {
  callerId: "principal_repository_rest",
  principalId: "principal_repository_rest",
  tenantId: "tenant_repository_rest",
};

const fixtureTime = new Date("2026-07-21T00:00:00.000Z");

function snapshot() {
  const reproCase = createCase("case_repository_rest", fixtureTime);
  return {
    case: reproCase,
    job: createJob("job_repository_rest", reproCase.id, fixtureTime),
    repositorySource: {
      commitSha: source.commitSha,
      fullName: "GhostlyGawd/reproforge-canary",
      private: true,
      provider: "github" as const,
      repositoryId: source.repositoryId,
    },
    result: null,
    schemaVersion: "2.0" as const,
  };
}

const source = {
  commitSha: "a".repeat(40),
  executionProfile: {
    controlScript: "test:control",
    ecosystem: "node" as const,
    lockfile: "package-lock.json" as const,
    nodeVersion: "24" as const,
    packageManager: "npm" as const,
    reproductionScript: "test:reproduce",
  },
  failureOracle: {
    id: "rest-oracle-v1",
    root: { expected: 1, type: "exit_code" as const },
    version: 1,
  },
  issueEvidence: { number: 13, title: "Synthetic REST canary" },
  kind: "github" as const,
  repositoryId: "repository_rest_42",
};

function authorized(): RepositoryApiAuthorizer {
  return vi.fn(async () => ({ ok: true as const, principal }));
}

function operations(
  overrides: Record<string, unknown>,
): RepositoryOperations {
  return overrides as unknown as RepositoryOperations;
}

describe("OAuth repository REST surface", () => {
  it("starts one authorized immutable repository command with header idempotency", async () => {
    const start = vi.fn(async () => ({
      reused: false,
      snapshot: snapshot(),
    }));
    const authorize = authorized();
    const response = await createStartRepositoryReproductionHandler({
      authorize,
      operations: operations({ startRepositoryReproduction: start }),
    })(
      new Request("https://reproforge.example/api/v2/repository-reproductions", {
        body: JSON.stringify({ source }),
        headers: {
          Authorization: "Bearer synthetic-token",
          "Content-Type": "application/json",
          "Idempotency-Key": "rest-repository-start",
        },
        method: "POST",
      }),
    );

    expect(response.status).toBe(201);
    expect(authorize).toHaveBeenCalledWith(
      expect.any(Request),
      ["reproforge:cases:write", "reproforge:repositories:read"],
    );
    expect(start).toHaveBeenCalledWith(principal, {
      budget: { maxToolCalls: 6, requiredRuns: 3 },
      idempotencyKey: "rest-repository-start",
      source,
    });
    await expect(response.json()).resolves.toMatchObject({
      data: {
        reused: false,
        snapshot: { case: { id: "case_repository_rest" } },
      },
      error: null,
      schemaVersion: "2.0",
    });
  });

  it("returns a standards-based bearer challenge before repository access", async () => {
    const start = vi.fn();
    const response = await createStartRepositoryReproductionHandler({
      authorize: async () => ({
        challenge:
          'Bearer resource_metadata="https://reproforge.example/.well-known/oauth-protected-resource", scope="reproforge:cases:write reproforge:repositories:read", error="invalid_token"',
        code: "AUTHENTICATION_REQUIRED",
        message: "Link your ReproForge account to continue",
        ok: false,
        status: 401,
      }),
      operations: operations({ startRepositoryReproduction: start }),
    })(
      new Request("https://reproforge.example/api/v2/repository-reproductions", {
        body: JSON.stringify({ source }),
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "rest-repository-start",
        },
        method: "POST",
      }),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain(
      "oauth-protected-resource",
    );
    expect(start).not.toHaveBeenCalled();
  });

  it.each([
    {
      expectedCode: "UNSUPPORTED_MEDIA_TYPE",
      expectedStatus: 415,
      headers: new Headers({ "Content-Type": "text/plain" }),
    },
    {
      expectedCode: "PAYLOAD_TOO_LARGE",
      expectedStatus: 413,
      headers: new Headers({
        "Content-Length": "16385",
        "Content-Type": "application/json",
      }),
    },
  ])(
    "rejects a bounded start body with $expectedCode",
    async ({ expectedCode, expectedStatus, headers }) => {
      const start = vi.fn();
      const requestHeaders = new Headers(headers);
      requestHeaders.set("Idempotency-Key", "rest-repository-start");
      const response = await createStartRepositoryReproductionHandler({
        authorize: authorized(),
        operations: operations({ startRepositoryReproduction: start }),
      })(
        new Request(
          "https://reproforge.example/api/v2/repository-reproductions",
          {
            body: JSON.stringify({ source }),
            headers: requestHeaders,
            method: "POST",
          },
        ),
      );

      expect(response.status).toBe(expectedStatus);
      await expect(response.json()).resolves.toMatchObject({
        data: null,
        error: { code: expectedCode, retryable: false },
        schemaVersion: "2.0",
      });
      expect(start).not.toHaveBeenCalled();
    },
  );

  it("lists and reads only through their least-privilege scopes", async () => {
    const authorize = authorized();
    const list = vi.fn(async () => ({
      nextCursor: null,
      repositories: [],
      tenantId: principal.tenantId,
    }));
    const get = vi.fn(async () => snapshot());
    const service = operations({
      getReproduction: get,
      listAuthorizedRepositories: list,
    });

    const listed = await createListAuthorizedRepositoriesHandler({
      authorize,
      operations: service,
    })(new Request("https://reproforge.example/api/v2/repositories?limit=25"));
    const read = await createGetRepositoryReproductionHandler({
      authorize,
      operations: service,
    })(new Request("https://reproforge.example/api/v2/repository-reproductions/case_repository_rest"), {
      params: Promise.resolve({ caseId: "case_repository_rest" }),
    });

    expect(listed.status).toBe(200);
    expect(read.status).toBe(200);
    expect(list).toHaveBeenCalledWith(principal, { limit: 25 });
    expect(get).toHaveBeenCalledWith(principal, {
      caseId: "case_repository_rest",
    });
    expect(authorize).toHaveBeenNthCalledWith(1, expect.any(Request), [
      "reproforge:repositories:read",
    ]);
    expect(authorize).toHaveBeenNthCalledWith(2, expect.any(Request), [
      "reproforge:cases:read",
    ]);
  });

  it("exports and cancels through separate bounded scopes", async () => {
    const authorize = authorized();
    const exportBundle = vi.fn(async () => ({
      bundle: { bundleHash: "b".repeat(64), schemaVersion: "1.1" },
      caseId: "case_repository_rest",
      files: {},
      schemaVersion: "2.0" as const,
    }));
    const cancel = vi.fn(async () => ({
      caseId: "case_repository_rest",
      changed: true,
      disposition: "requested" as const,
    }));
    const service = operations({
      cancelReproduction: cancel,
      exportReproBundle: exportBundle,
    });

    const exported = await createExportRepositoryBundleHandler({
      authorize,
      operations: service,
    })(new Request("https://reproforge.example/export"), {
      params: Promise.resolve({ caseId: "case_repository_rest" }),
    });
    const cancelled = await createCancelRepositoryReproductionHandler({
      authorize,
      operations: service,
    })(new Request("https://reproforge.example/cancel", { method: "POST" }), {
      params: Promise.resolve({ jobId: "job_repository_rest" }),
    });

    expect(exported.status).toBe(200);
    expect(cancelled.status).toBe(200);
    expect(exportBundle).toHaveBeenCalledWith(principal, {
      caseId: "case_repository_rest",
    });
    expect(cancel).toHaveBeenCalledWith(principal, {
      jobId: "job_repository_rest",
    });
    expect(authorize).toHaveBeenNthCalledWith(1, expect.any(Request), [
      "reproforge:bundles:read",
    ]);
    expect(authorize).toHaveBeenNthCalledWith(2, expect.any(Request), [
      "reproforge:cases:write",
    ]);
  });
});
