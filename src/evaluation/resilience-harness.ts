import { z } from "zod";

export const RESILIENCE_CATEGORIES = [
  "load",
  "duplicate-delivery",
  "restart",
  "dependency-outage",
  "worker-loss",
  "queue-lag",
  "storage-failure",
  "sandbox-failure",
] as const;

const scenarioSchema = z
  .object({
    category: z.enum(RESILIENCE_CATEGORIES),
    deterministicSeed: z.number().int().min(1).max(2_147_483_647),
    invariant: z.string().min(21).max(512),
    testFiles: z
      .array(
        z
          .string()
          .regex(/^tests\/[A-Za-z0-9._/-]+\.test\.ts$/),
      )
      .min(1)
      .max(8),
  })
  .strict();

export const resilienceHarnessRegistrySchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    scenarios: z.array(scenarioSchema).length(RESILIENCE_CATEGORIES.length),
  })
  .strict()
  .superRefine((registry, context) => {
    const categories = registry.scenarios.map(({ category }) => category);
    const seeds = registry.scenarios.map(({ deterministicSeed }) =>
      deterministicSeed,
    );
    if (
      new Set(categories).size !== RESILIENCE_CATEGORIES.length ||
      !RESILIENCE_CATEGORIES.every((category) => categories.includes(category))
    ) {
      context.addIssue({
        code: "custom",
        message: "Every resilience category must appear exactly once",
        path: ["scenarios"],
      });
    }
    if (new Set(seeds).size !== seeds.length) {
      context.addIssue({
        code: "custom",
        message: "Every resilience campaign requires a unique seed",
        path: ["scenarios"],
      });
    }
  });

export type ResilienceHarnessRegistry = z.infer<
  typeof resilienceHarnessRegistrySchema
>;
