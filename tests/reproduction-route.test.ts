import { describe, expect, it } from "vitest";

import { CaseService } from "@/application/case-service";
import {
  createExportBundleHandler,
  createGetJobHandler,
  createGetReproductionHandler,
  createStartReproductionHandler,
} from "@/app/api/v2/handlers";
import { InMemoryReproductionRepository } from "@/infrastructure/reproduction-repository";

function createService() {
  return new CaseService({
    clock: { now: () => new Date("2026-07-19T19:00:00.000Z") },
    identifiers: {
      nextCaseId: () => "case-route",
      nextJobId: () => "job-route",
    },
    repository: new InMemoryReproductionRepository(),
  });
}

function postRequest(body: unknown, idempotencyKey?: string) {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (idempotencyKey) headers.set("Idempotency-Key", idempotencyKey);
  return new Request("http://localhost/api/v2/reproductions", {
    body: JSON.stringify(body),
    headers,
    method: "POST",
  });
}

describe("reproduction REST v2", () => {
  it("requires an idempotency key for start", async () => {
    const handler = createStartReproductionHandler(createService(), () => "request-1");
    const response = await handler(postRequest({ sampleId: "cli-spaces" }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      data: null,
      error: {
        code: "INVALID_REQUEST",
        message: "A valid Idempotency-Key header is required",
        retryable: false,
      },
      requestId: "request-1",
      schemaVersion: "2.0",
    });
  });

  it("returns 201 for a new start and 200 for its retry", async () => {
    const service = createService();
    const handler = createStartReproductionHandler(service, () => "request-2");

    const first = await handler(
      postRequest({ sampleId: "cli-spaces" }, "route-idempotency"),
    );
    const second = await handler(
      postRequest({ sampleId: "cli-spaces" }, "route-idempotency"),
    );
    const firstBody = await first.json();
    const secondBody = await second.json();

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(firstBody.data.snapshot.case.id).toBe("case-route");
    expect(firstBody.data.progress).toMatchObject({
      cancellable: false,
      phase: "VERIFIED",
      state: "SUCCEEDED",
      terminal: true,
    });
    expect(secondBody.data.snapshot.case.id).toBe(firstBody.data.snapshot.case.id);
    expect(secondBody.data.reused).toBe(true);
  });

  it("maps an unknown case to a stable not-found error", async () => {
    const handler = createGetReproductionHandler(createService(), () => "request-3");
    const response = await handler(
      new Request("http://localhost/api/v2/reproductions/missing"),
      { params: Promise.resolve({ caseId: "missing" }) },
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      data: null,
      error: { code: "NOT_FOUND", retryable: false },
      requestId: "request-3",
      schemaVersion: "2.0",
    });
  });

  it("polls the job and exports the completed bundle through stable envelopes", async () => {
    const service = createService();
    const start = createStartReproductionHandler(service, () => "request-start");
    const poll = createGetJobHandler(service, () => "request-poll");
    const exportBundle = createExportBundleHandler(
      service,
      () => "request-export",
    );
    await start(postRequest({ sampleId: "cli-spaces" }, "route-complete"));

    const jobResponse = await poll(
      new Request("http://localhost/api/v2/jobs/job-route"),
      { params: Promise.resolve({ jobId: "job-route" }) },
    );
    const bundleResponse = await exportBundle(
      new Request("http://localhost/api/v2/reproductions/case-route/bundle"),
      { params: Promise.resolve({ caseId: "case-route" }) },
    );

    expect(jobResponse.status).toBe(200);
    await expect(jobResponse.json()).resolves.toMatchObject({
      data: {
        job: { id: "job-route", state: "SUCCEEDED" },
        progress: {
          cancellable: false,
          phase: "VERIFIED",
          state: "SUCCEEDED",
          terminal: true,
        },
      },
      error: null,
      requestId: "request-poll",
      schemaVersion: "2.0",
    });
    expect(bundleResponse.status).toBe(200);
    await expect(bundleResponse.json()).resolves.toMatchObject({
      data: {
        bundle: { caseId: "case-route", schemaVersion: "1.1" },
        caseId: "case-route",
        schemaVersion: "2.0",
      },
      error: null,
      requestId: "request-export",
      schemaVersion: "2.0",
    });
  });
});
