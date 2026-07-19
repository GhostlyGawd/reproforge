import { describe, expect, it } from "vitest";

import { createRuntimeHealthService } from "@/infrastructure/operations/runtime-health";
import {
  InMemoryOperationalMetrics,
  JsonOperationalLogger,
} from "@/infrastructure/operations/observability";

function observability() {
  const lines: string[] = [];
  return {
    lines,
    logger: new JsonOperationalLogger({
      sink: {
        error: (line) => lines.push(line),
        info: (line) => lines.push(line),
      },
    }),
    metrics: new InMemoryOperationalMetrics(),
  };
}

describe("runtime health composition", () => {
  it("fails hosted readiness without silently substituting local providers", async () => {
    const telemetry = observability();
    const health = createRuntimeHealthService({
      clock: { now: () => new Date("2026-07-19T20:00:00.000Z") },
      environment: {
        DATABASE_URL: "postgresql://user:highly-sensitive@example.invalid/db",
        REPROFORGE_RUNTIME_MODE: "production",
      },
      ...telemetry,
    });

    await expect(health.readiness()).resolves.toMatchObject({
      status: "unavailable",
      checks: [
        {
          code: "INVALID_RUNTIME_CONFIGURATION",
          component: "configuration",
          status: "unavailable",
        },
      ],
    });
    await expect(health.liveness()).resolves.toMatchObject({ status: "ready" });
    const serialized = JSON.stringify(telemetry.lines);
    expect(serialized).not.toContain("highly-sensitive");
    expect(serialized).not.toContain("postgresql://");
    expect(serialized).not.toContain("LOCAL_");
  });

  it("reports explicit local providers in test mode without network calls", async () => {
    const telemetry = observability();
    const health = createRuntimeHealthService({
      clock: { now: () => new Date("2026-07-19T20:00:00.000Z") },
      environment: { REPROFORGE_RUNTIME_MODE: "test" },
      ...telemetry,
    });

    await expect(health.readiness()).resolves.toMatchObject({
      status: "ready",
      checks: [
        { code: "LOCAL_DATABASE_READY", component: "database" },
        { code: "LOCAL_ARTIFACT_STORE_READY", component: "artifact-store" },
        { code: "LOCAL_QUEUE_READY", component: "queue" },
      ],
    });
  });
});
