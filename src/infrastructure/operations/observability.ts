import { z } from "zod";

import {
  HEALTH_COMPONENTS,
  type HealthComponent,
  type HealthStatus,
  type OperationalLogEvent,
  type OperationalLogger,
  type OperationalMetrics,
} from "@/application/health";

type LogSink = Readonly<{
  error(line: string): void;
  info(line: string): void;
}>;

const opaqueId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

const serializedEventSchema = z
  .object({
    at: z.string().datetime(),
    attempt: z.number().int().positive().max(100).optional(),
    caseId: opaqueId.optional(),
    code: z.string().regex(/^[A-Z][A-Z0-9_]{0,95}$/),
    component: z.enum(HEALTH_COMPONENTS),
    durationMs: z.number().int().nonnegative().max(86_400_000),
    event: z.literal("health.check"),
    jobId: opaqueId.optional(),
    level: z.enum(["error", "info"]),
    outcome: z.enum(["ready", "unavailable"]),
    principalId: opaqueId.optional(),
    queueDeliveryId: opaqueId.optional(),
    requestId: opaqueId.optional(),
    sandboxId: opaqueId.optional(),
    schemaVersion: z.literal("1.0"),
    tenantId: opaqueId.optional(),
  })
  .strict();

const credentialPattern =
  /(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_-]{8,}|bearer[_\s]+[A-Za-z0-9._-]{8,}|postgres(?:ql)?:\/\/[^\s@]+@[^\s]+)/gi;

function redact(value: string, secrets: readonly string[]): string {
  let sanitized = value;
  for (const secret of secrets) {
    if (secret.length >= 4) sanitized = sanitized.split(secret).join("redacted");
  }
  return sanitized.replace(credentialPattern, "redacted");
}

function safeId(value: unknown, secrets: readonly string[]): string | undefined {
  if (typeof value !== "string") return undefined;
  const sanitized = redact(value, secrets);
  return opaqueId.safeParse(sanitized).success ? sanitized : "redacted";
}

export class JsonOperationalLogger implements OperationalLogger {
  private readonly secrets: string[];

  constructor(
    private readonly options: {
      secrets?: readonly string[];
      sink?: LogSink;
    } = {},
  ) {
    this.secrets = [...new Set((options.secrets ?? []).filter(Boolean))];
  }

  emit(rawEvent: OperationalLogEvent): void {
    const source = rawEvent as OperationalLogEvent & Record<string, unknown>;
    const event = serializedEventSchema.parse({
      at: source.at,
      ...(Number.isInteger(source.attempt) ? { attempt: source.attempt } : {}),
      ...(safeId(source.caseId, this.secrets)
        ? { caseId: safeId(source.caseId, this.secrets) }
        : {}),
      code: source.code,
      component: source.component,
      durationMs: source.durationMs,
      event: source.event,
      ...(safeId(source.jobId, this.secrets)
        ? { jobId: safeId(source.jobId, this.secrets) }
        : {}),
      level: source.level,
      outcome: source.outcome,
      ...(safeId(source.principalId, this.secrets)
        ? { principalId: safeId(source.principalId, this.secrets) }
        : {}),
      ...(safeId(source.queueDeliveryId, this.secrets)
        ? { queueDeliveryId: safeId(source.queueDeliveryId, this.secrets) }
        : {}),
      ...(safeId(source.requestId, this.secrets)
        ? { requestId: safeId(source.requestId, this.secrets) }
        : {}),
      ...(safeId(source.sandboxId, this.secrets)
        ? { sandboxId: safeId(source.sandboxId, this.secrets) }
        : {}),
      schemaVersion: "1.0",
      ...(safeId(source.tenantId, this.secrets)
        ? { tenantId: safeId(source.tenantId, this.secrets) }
        : {}),
    });
    const line = JSON.stringify(event);
    const sink = this.options.sink ?? console;
    if (event.level === "error") sink.error(line);
    else sink.info(line);
  }
}

export type OperationalMetricPoint = Readonly<{
  component: HealthComponent;
  count: number;
  maxDurationMs: number;
  status: HealthStatus;
  totalDurationMs: number;
}>;

export class InMemoryOperationalMetrics implements OperationalMetrics {
  private readonly points = new Map<string, OperationalMetricPoint>();

  recordHealthCheck(input: {
    component: HealthComponent;
    durationMs: number;
    status: HealthStatus;
  }): void {
    if (
      !HEALTH_COMPONENTS.includes(input.component) ||
      !["ready", "unavailable"].includes(input.status) ||
      !Number.isInteger(input.durationMs) ||
      input.durationMs < 0 ||
      input.durationMs > 86_400_000
    ) {
      throw new Error("Invalid operational metric");
    }
    const key = `${input.component}:${input.status}`;
    const current = this.points.get(key);
    this.points.set(key, {
      component: input.component,
      count: (current?.count ?? 0) + 1,
      maxDurationMs: Math.max(current?.maxDurationMs ?? 0, input.durationMs),
      status: input.status,
      totalDurationMs: (current?.totalDurationMs ?? 0) + input.durationMs,
    });
  }

  snapshot(): OperationalMetricPoint[] {
    return [...this.points.values()].sort((left, right) =>
      `${left.component}:${left.status}`.localeCompare(
        `${right.component}:${right.status}`,
      ),
    );
  }
}
