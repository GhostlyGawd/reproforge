import {
  HealthService,
  type HealthProbe,
  type OperationalLogger,
  type OperationalMetrics,
} from "@/application/health";
import {
  parseRuntimeConfig,
  type RuntimeEnvironment,
} from "@/config/runtime";
import { VercelPrivateBlobClient } from "@/infrastructure/artifacts/vercel-private-blob-client";
import { createNeonPostgresDatabase } from "@/infrastructure/postgres/neon-database";
import { VercelJobQueue } from "@/infrastructure/queue/vercel-job-queue";

import {
  InMemoryOperationalMetrics,
  JsonOperationalLogger,
} from "./observability";

type RuntimeHealthOptions = Readonly<{
  clock: { now(): Date };
  environment: RuntimeEnvironment;
  hostedProbes?: Partial<
    Record<"artifact-store" | "database" | "queue" | "runner", HealthProbe>
  >;
  logger: OperationalLogger;
  metrics: OperationalMetrics;
}>;

function fixedProbe(
  component: HealthProbe["component"],
  code: string,
  status: "ready" | "unavailable" = "ready",
): HealthProbe {
  return { check: async () => ({ code, status }), component };
}

export function createRuntimeHealthService(
  options: RuntimeHealthOptions,
): HealthService {
  let config: ReturnType<typeof parseRuntimeConfig> | null = null;
  try {
    config = parseRuntimeConfig(options.environment);
  } catch {
    return new HealthService({
      clock: options.clock,
      logger: options.logger,
      metrics: options.metrics,
      readinessProbes: [
        fixedProbe(
          "configuration",
          "INVALID_RUNTIME_CONFIGURATION",
          "unavailable",
        ),
      ],
      runnerProbe: fixedProbe(
        "runner",
        "RUNNER_NOT_CONFIGURED",
        "unavailable",
      ),
      timeoutMs: 2_000,
    });
  }

  if (!("credentials" in config)) {
    return new HealthService({
      clock: options.clock,
      logger: options.logger,
      metrics: options.metrics,
      readinessProbes: [
        fixedProbe("database", "LOCAL_DATABASE_READY"),
        fixedProbe("artifact-store", "LOCAL_ARTIFACT_STORE_READY"),
        fixedProbe("queue", "LOCAL_QUEUE_READY"),
      ],
      runnerProbe:
        options.hostedProbes?.runner ??
        fixedProbe("runner", "RUNNER_NOT_CONFIGURED", "unavailable"),
      timeoutMs: 2_000,
    });
  }

  const hostedConfig = config;

  const databaseProbe: HealthProbe =
    options.hostedProbes?.database ?? {
      component: "database",
      check: async () => {
        const database = createNeonPostgresDatabase(
          hostedConfig.credentials.databaseUrl,
        );
        try {
          const result = await database.query<{ ready: number }>(
            "SELECT 1 AS ready",
          );
          return result.rows[0]?.ready === 1
            ? { code: "DATABASE_READY", status: "ready" }
            : { code: "DATABASE_UNAVAILABLE", status: "unavailable" };
        } finally {
          await database.close();
        }
      },
    };
  const artifactProbe: HealthProbe =
    options.hostedProbes?.["artifact-store"] ?? {
      component: "artifact-store",
      check: async () => {
        const client = new VercelPrivateBlobClient(
          hostedConfig.credentials.blob,
        );
        await client.head("reproforge-health/readiness");
        return { code: "ARTIFACT_STORE_READY", status: "ready" };
      },
    };
  const queueProbe: HealthProbe =
    options.hostedProbes?.queue ?? {
      component: "queue",
      check: async () => {
        new VercelJobQueue({
          region: hostedConfig.queueRegion,
          retentionSeconds: hostedConfig.queueRetentionSeconds,
          topic: hostedConfig.queueTopic,
        });
        return { code: "QUEUE_CONFIGURATION_READY", status: "ready" };
      },
    };

  return new HealthService({
    clock: options.clock,
    logger: options.logger,
    metrics: options.metrics,
    readinessProbes: [databaseProbe, artifactProbe, queueProbe],
    runnerProbe:
      options.hostedProbes?.runner ??
      fixedProbe("runner", "RUNNER_NOT_CONFIGURED", "unavailable"),
    timeoutMs: 2_000,
  });
}

export const runtimeHealthMetrics = new InMemoryOperationalMetrics();

const runtimeLogger = new JsonOperationalLogger({
  secrets: [
    process.env.DATABASE_URL,
    process.env.BLOB_READ_WRITE_TOKEN,
    process.env.VERCEL_OIDC_TOKEN,
  ].filter((value): value is string => Boolean(value)),
});

export const defaultRuntimeHealthService = createRuntimeHealthService({
  clock: { now: () => new Date() },
  environment: process.env,
  logger: runtimeLogger,
  metrics: runtimeHealthMetrics,
});
