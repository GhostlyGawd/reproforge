import { describe, expect, it } from "vitest";

import { HealthService, type HealthProbe } from "@/application/health";
import { createHealthHandler } from "@/app/health/handlers";
import {
  InMemoryOperationalMetrics,
  JsonOperationalLogger,
} from "@/infrastructure/operations/observability";

const noopLogger = new JsonOperationalLogger({
  sink: { error: () => undefined, info: () => undefined },
});

function health(probes: HealthProbe[]) {
  return new HealthService({
    clock: { now: () => new Date("2026-07-19T20:00:00.000Z") },
    logger: noopLogger,
    metrics: new InMemoryOperationalMetrics(),
    readinessProbes: probes,
    runnerProbe: {
      check: async () => ({ code: "RUNNER_NOT_CONFIGURED", status: "unavailable" }),
      component: "runner",
    },
    timeoutMs: 100,
  });
}

describe("health routes", () => {
  it("serves cache-disabled process liveness with no dependency detail", async () => {
    const response = await createHealthHandler(health([]), "liveness")(
      new Request("http://localhost/health/live"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    await expect(response.json()).resolves.toMatchObject({
      checks: [],
      kind: "liveness",
      status: "ready",
    });
  });

  it("returns 503 and a stable retry hint when a required dependency is unavailable", async () => {
    const response = await createHealthHandler(
      health([
        {
          check: async () => ({ code: "DATABASE_UNAVAILABLE", status: "unavailable" }),
          component: "database",
        },
      ]),
      "readiness",
    )(new Request("http://localhost/health/ready"));

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
    await expect(response.json()).resolves.toMatchObject({
      kind: "readiness",
      status: "unavailable",
      checks: [{ code: "DATABASE_UNAVAILABLE", component: "database" }],
    });
  });

  it("keeps runner capability unavailable without failing process liveness", async () => {
    const service = health([]);
    const runner = await createHealthHandler(service, "runner")(
      new Request("http://localhost/health/runner"),
    );
    const live = await createHealthHandler(service, "liveness")(
      new Request("http://localhost/health/live"),
    );

    expect(runner.status).toBe(503);
    expect(live.status).toBe(200);
  });
});
