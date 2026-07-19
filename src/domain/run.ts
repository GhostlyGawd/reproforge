import { z } from "zod";

export const runResultSchema = z
  .object({
    id: z.string().min(1),
    command: z.string().min(1),
    durationMs: z.number().int().nonnegative(),
    environmentHash: z.string().min(1),
    exitCode: z.number().int(),
    stderr: z.string(),
    stdout: z.string(),
  })
  .strict();

export type RunResult = z.infer<typeof runResultSchema>;

