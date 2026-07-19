import { z } from "zod";

export type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

const runtimeModeSchema = z.enum(["offline", "test", "preview", "production"]);

const knownReproForgeVariables = new Set([
  "REPROFORGE_BASE_URL",
  "REPROFORGE_JOB_LEASE_SECONDS",
  "REPROFORGE_MAX_ACTIVE_JOBS_PER_TENANT",
  "REPROFORGE_RETENTION_DAYS",
  "REPROFORGE_RUNTIME_MODE",
]);

const policySchema = z
  .object({
    jobLeaseSeconds: z.coerce.number().int().min(30).max(3600).default(90),
    maxActiveJobsPerTenant: z.coerce.number().int().min(1).max(100).default(2),
    retentionDays: z.coerce.number().int().min(1).max(365).default(30),
  })
  .strict();

const hostedSchema = z
  .object({
    baseUrl: z
      .url()
      .transform((value) => new URL(value))
      .refine((value) => value.protocol === "https:", "must use HTTPS"),
    blobReadWriteToken: z.string().min(1),
    databaseUrl: z
      .url()
      .refine(
        (value) => ["postgres:", "postgresql:"].includes(new URL(value).protocol),
        "must use a PostgreSQL URL",
      ),
  })
  .strict();

type RuntimePolicy = z.infer<typeof policySchema>;

type OfflineRuntimeConfig = RuntimePolicy & {
  baseUrl: null;
  mode: "offline" | "test";
  providers: {
    artifactStore: "memory";
    database: "memory";
    queue: "inline";
  };
};

type HostedRuntimeConfig = RuntimePolicy & {
  baseUrl: string;
  credentials: {
    blobReadWriteToken: string;
    databaseUrl: string;
  };
  mode: "preview" | "production";
  providers: {
    artifactStore: "vercel-blob";
    database: "neon";
    queue: "vercel";
  };
};

export type RuntimeConfig = OfflineRuntimeConfig | HostedRuntimeConfig;

export type RuntimeConfigSummary = RuntimePolicy & {
  baseUrlConfigured: boolean;
  credentialsConfigured: boolean;
  mode: RuntimeConfig["mode"];
  providers: RuntimeConfig["providers"];
};

export class RuntimeConfigurationError extends Error {
  readonly code = "INVALID_RUNTIME_CONFIGURATION" as const;

  constructor(readonly issues: string[]) {
    super(`Invalid runtime configuration: ${[...new Set(issues)].sort().join(", ")}`);
    this.name = "RuntimeConfigurationError";
  }
}

function deriveMode(environment: RuntimeEnvironment): RuntimeConfig["mode"] {
  const explicit = environment.REPROFORGE_RUNTIME_MODE;
  if (explicit !== undefined) {
    const parsed = runtimeModeSchema.safeParse(explicit);
    if (!parsed.success) {
      throw new RuntimeConfigurationError(["REPROFORGE_RUNTIME_MODE"]);
    }
    return parsed.data;
  }
  if (environment.VERCEL_ENV === "production") return "production";
  if (environment.VERCEL_ENV === "preview") return "preview";
  if (environment.NODE_ENV === "test") return "test";
  return "offline";
}

function findUnknownVariables(environment: RuntimeEnvironment): string[] {
  return Object.keys(environment).filter(
    (name) =>
      name.startsWith("REPROFORGE_") && !knownReproForgeVariables.has(name),
  );
}

function issueFields(
  result: z.ZodSafeParseError<unknown>,
  sourceFields: Readonly<Record<string, string>>,
): string[] {
  return result.error.issues.map((issue) => {
    const field = String(issue.path[0] ?? "runtime");
    return sourceFields[field] ?? field;
  });
}

export function parseRuntimeConfig(
  environment: RuntimeEnvironment,
): RuntimeConfig {
  const unknown = findUnknownVariables(environment);
  if (unknown.length > 0) throw new RuntimeConfigurationError(unknown);

  const mode = deriveMode(environment);
  const policyResult = policySchema.safeParse({
    jobLeaseSeconds: environment.REPROFORGE_JOB_LEASE_SECONDS,
    maxActiveJobsPerTenant:
      environment.REPROFORGE_MAX_ACTIVE_JOBS_PER_TENANT,
    retentionDays: environment.REPROFORGE_RETENTION_DAYS,
  });
  if (!policyResult.success) {
    throw new RuntimeConfigurationError(
      issueFields(policyResult, {
        jobLeaseSeconds: "REPROFORGE_JOB_LEASE_SECONDS",
        maxActiveJobsPerTenant: "REPROFORGE_MAX_ACTIVE_JOBS_PER_TENANT",
        retentionDays: "REPROFORGE_RETENTION_DAYS",
      }),
    );
  }

  if (mode === "offline" || mode === "test") {
    return {
      ...policyResult.data,
      baseUrl: null,
      mode,
      providers: {
        artifactStore: "memory",
        database: "memory",
        queue: "inline",
      },
    };
  }

  const hostedResult = hostedSchema.safeParse({
    baseUrl: environment.REPROFORGE_BASE_URL,
    blobReadWriteToken: environment.BLOB_READ_WRITE_TOKEN,
    databaseUrl: environment.DATABASE_URL,
  });
  if (!hostedResult.success) {
    throw new RuntimeConfigurationError(
      issueFields(hostedResult, {
        baseUrl: "REPROFORGE_BASE_URL",
        blobReadWriteToken: "BLOB_READ_WRITE_TOKEN",
        databaseUrl: "DATABASE_URL",
      }),
    );
  }

  return {
    ...policyResult.data,
    baseUrl: hostedResult.data.baseUrl.toString(),
    credentials: {
      blobReadWriteToken: hostedResult.data.blobReadWriteToken,
      databaseUrl: hostedResult.data.databaseUrl,
    },
    mode,
    providers: {
      artifactStore: "vercel-blob",
      database: "neon",
      queue: "vercel",
    },
  };
}

export function summarizeRuntimeConfig(
  config: RuntimeConfig,
): RuntimeConfigSummary {
  return {
    baseUrlConfigured: config.baseUrl !== null,
    credentialsConfigured: config.mode === "preview" || config.mode === "production",
    jobLeaseSeconds: config.jobLeaseSeconds,
    maxActiveJobsPerTenant: config.maxActiveJobsPerTenant,
    mode: config.mode,
    providers: config.providers,
    retentionDays: config.retentionDays,
  };
}

export function createRuntimeConfigLoader(
  readEnvironment: () => RuntimeEnvironment,
): () => RuntimeConfig {
  let config: RuntimeConfig | undefined;
  let failure: unknown;
  let loaded = false;

  return () => {
    if (!loaded) {
      loaded = true;
      try {
        config = parseRuntimeConfig(readEnvironment());
      } catch (error) {
        failure = error;
      }
    }
    if (failure) throw failure;
    return config as RuntimeConfig;
  };
}

export const getRuntimeConfig = createRuntimeConfigLoader(() => process.env);
