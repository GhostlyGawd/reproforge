import { describe, expect, it, vi } from "vitest";

import {
  HealthService,
  type HealthComponent,
  type HealthProbe,
} from "@/application/health";
import {
  InMemoryOperationalMetrics,
  JsonOperationalLogger,
} from "@/infrastructure/operations/observability";

const AT = "2026-07-19T20:00:00.000Z";

function probe(
  component: HealthComponent,
  check: HealthProbe["check"],
): HealthProbe {
  return { check, component };
}

function service(input: {
  readiness: HealthProbe[];
  runner?: HealthProbe;
}) {
  const lines: string[] = [];
  const metrics = new InMemoryOperationalMetrics();
  const logger = new JsonOperationalLogger({
    sink: {
      error: (line) => lines.push(line),
      info: (line) => lines.push(line),
    },
  });
  return {
    health: new HealthService({
      clock: { now: () => new Date(AT) },
      logger,
      metrics,
      readinessProbes: input.readiness,
      runnerProbe:
        input.runner ??
        probe("runner", async () => ({
          code: "RUNNER_NOT_CONFIGURED",
          status: "unavailable",
        })),
      timeoutMs: 50,
    }),
    lines,
    metrics,
  };
}

describe("health service", () => {
  it("reports process liveness without touching any dependency", async () => {
    const check = vi.fn<HealthProbe["check"]>();
    const fixture = service({ readiness: [probe("database", check)] });

    await expect(fixture.health.liveness()).resolves.toEqual({
      checkedAt: AT,
      checks: [],
      kind: "liveness",
      schemaVersion: "1.0",
      service: "reproforge",
      status: "ready",
    });
    expect(check).not.toHaveBeenCalled();
  });

  it("requires every configured dependency while keeping runner health separate", async () => {
    const fixture = service({
      readiness: [
        probe("database", async () => ({ code: "DATABASE_READY", status: "ready" })),
        probe("artifact-store", async () => ({
          code: "ARTIFACT_STORE_READY",
          status: "ready",
        })),
        probe("queue", async () => ({
          code: "QUEUE_UNAVAILABLE",
          status: "unavailable",
        })),
      ],
      runner: probe("runner", async () => ({
        code: "RUNNER_READY",
        status: "ready",
      })),
    });

    const readiness = await fixture.health.readiness({ requestId: "request_ready" });
    expect(readiness).toMatchObject({
      kind: "readiness",
      status: "unavailable",
      checks: [
        { code: "DATABASE_READY", component: "database", status: "ready" },
        {
          code: "ARTIFACT_STORE_READY",
          component: "artifact-store",
          status: "ready",
        },
        { code: "QUEUE_UNAVAILABLE", component: "queue", status: "unavailable" },
      ],
    });
    await expect(fixture.health.runner()).resolves.toMatchObject({
      kind: "runner",
      status: "ready",
    });
    expect(fixture.metrics.snapshot()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          component: "queue",
          count: 1,
          status: "unavailable",
        }),
      ]),
    );
    expect(fixture.lines.map((line) => JSON.parse(line))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "QUEUE_UNAVAILABLE",
          component: "queue",
          event: "health.check",
          requestId: "request_ready",
        }),
      ]),
    );
  });

  it("maps provider exceptions and timeouts to stable sanitized codes", async () => {
    const fixture = service({
      readiness: [
        probe("database", async () => {
          throw new Error("postgresql://admin:super-secret@example.invalid/db");
        }),
        probe("artifact-store", () => new Promise(() => undefined)),
      ],
    });

    const result = await fixture.health.readiness();

    expect(result).toMatchObject({
      status: "unavailable",
      checks: [
        {
          code: "DEPENDENCY_UNAVAILABLE",
          component: "database",
          status: "unavailable",
        },
        {
          code: "DEPENDENCY_TIMEOUT",
          component: "artifact-store",
          status: "unavailable",
        },
      ],
    });
    const serialized = JSON.stringify({ lines: fixture.lines, result });
    expect(serialized).not.toContain("super-secret");
    expect(serialized).not.toContain("admin:");
  });
});
