import { z } from "zod";

export const HEALTH_COMPONENTS = [
  "process",
  "configuration",
  "database",
  "artifact-store",
  "queue",
  "runner",
] as const;

export type HealthComponent = (typeof HEALTH_COMPONENTS)[number];
export type HealthStatus = "ready" | "unavailable";
export type HealthKind = "liveness" | "readiness" | "runner";

const healthProbeResultSchema = z
  .object({
    code: z.string().regex(/^[A-Z][A-Z0-9_]{0,95}$/),
    status: z.enum(["ready", "unavailable"]),
  })
  .strict();

export type HealthProbeResult = z.infer<typeof healthProbeResultSchema>;

export type HealthProbe = Readonly<{
  check(): Promise<HealthProbeResult>;
  component: HealthComponent;
}>;

export type HealthCheck = Readonly<HealthProbeResult & {
  component: HealthComponent;
  durationMs: number;
}>;

export type HealthReport = Readonly<{
  checkedAt: string;
  checks: HealthCheck[];
  kind: HealthKind;
  schemaVersion: "1.0";
  service: "reproforge";
  status: HealthStatus;
}>;

export type OperationalLogEvent = Readonly<{
  at: string;
  attempt?: number;
  caseId?: string;
  code: string;
  component: HealthComponent;
  durationMs: number;
  event: "health.check";
  jobId?: string;
  level: "error" | "info";
  outcome: HealthStatus;
  principalId?: string;
  queueDeliveryId?: string;
  requestId?: string;
  sandboxId?: string;
  tenantId?: string;
}>;

export interface OperationalLogger {
  emit(event: OperationalLogEvent): void;
}

export interface OperationalMetrics {
  recordHealthCheck(input: {
    component: HealthComponent;
    durationMs: number;
    status: HealthStatus;
  }): void;
}

class ProbeTimeoutError extends Error {}

function timeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ProbeTimeoutError()), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

type HealthServiceDependencies = Readonly<{
  clock: { now(): Date };
  logger: OperationalLogger;
  metrics: OperationalMetrics;
  readinessProbes: readonly HealthProbe[];
  runnerProbe: HealthProbe;
  runnerTimeoutMs?: number;
  timeoutMs: number;
}>;

export class HealthService {
  constructor(private readonly dependencies: HealthServiceDependencies) {
    const components = dependencies.readinessProbes.map(({ component }) => component);
    if (
      !Number.isInteger(dependencies.timeoutMs) ||
      dependencies.timeoutMs < 10 ||
      dependencies.timeoutMs > 30_000 ||
      new Set(components).size !== components.length ||
      components.includes("process") ||
      components.includes("runner") ||
      dependencies.runnerProbe.component !== "runner" ||
      (dependencies.runnerTimeoutMs !== undefined &&
        (!Number.isInteger(dependencies.runnerTimeoutMs) ||
          dependencies.runnerTimeoutMs < 10 ||
          dependencies.runnerTimeoutMs > 30_000))
    ) {
      throw new Error("Invalid health service configuration");
    }
  }

  async liveness(context: { requestId?: string } = {}): Promise<HealthReport> {
    const checkedAt = this.dependencies.clock.now().toISOString();
    this.record(
      {
        code: "PROCESS_ALIVE",
        component: "process",
        durationMs: 0,
        status: "ready",
      },
      checkedAt,
      context.requestId,
    );
    return this.report("liveness", checkedAt, []);
  }

  async readiness(context: { requestId?: string } = {}): Promise<HealthReport> {
    const checkedAt = this.dependencies.clock.now().toISOString();
    const checks = await Promise.all(
      this.dependencies.readinessProbes.map((probe) =>
        this.runProbe(probe, checkedAt, context.requestId),
      ),
    );
    return this.report("readiness", checkedAt, checks);
  }

  async runner(context: { requestId?: string } = {}): Promise<HealthReport> {
    const checkedAt = this.dependencies.clock.now().toISOString();
    const check = await this.runProbe(
      this.dependencies.runnerProbe,
      checkedAt,
      context.requestId,
      this.dependencies.runnerTimeoutMs ?? this.dependencies.timeoutMs,
    );
    return this.report("runner", checkedAt, [check]);
  }

  private async runProbe(
    probe: HealthProbe,
    checkedAt: string,
    requestId?: string,
    timeoutMs = this.dependencies.timeoutMs,
  ): Promise<HealthCheck> {
    const startedAt = Date.now();
    let result: HealthProbeResult;
    try {
      result = healthProbeResultSchema.parse(
        await timeout(probe.check(), timeoutMs),
      );
    } catch (error) {
      result = {
        code:
          error instanceof ProbeTimeoutError
            ? "DEPENDENCY_TIMEOUT"
            : "DEPENDENCY_UNAVAILABLE",
        status: "unavailable",
      };
    }
    const check: HealthCheck = {
      ...result,
      component: probe.component,
      durationMs: Math.max(0, Math.round(Date.now() - startedAt)),
    };
    this.record(check, checkedAt, requestId);
    return check;
  }

  private record(
    check: HealthCheck,
    at: string,
    requestId?: string,
  ): void {
    this.dependencies.metrics.recordHealthCheck(check);
    this.dependencies.logger.emit({
      at,
      code: check.code,
      component: check.component,
      durationMs: check.durationMs,
      event: "health.check",
      level: check.status === "ready" ? "info" : "error",
      outcome: check.status,
      ...(requestId ? { requestId } : {}),
    });
  }

  private report(
    kind: HealthKind,
    checkedAt: string,
    checks: HealthCheck[],
  ): HealthReport {
    return {
      checkedAt,
      checks,
      kind,
      schemaVersion: "1.0",
      service: "reproforge",
      status: checks.every(({ status }) => status === "ready")
        ? "ready"
        : "unavailable",
    };
  }
}
