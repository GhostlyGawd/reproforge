import { z } from "zod";

export const runOutputCaptureSchema = z
  .object({
    originalBytes: z.number().int().nonnegative().safe(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    truncated: z.boolean(),
  })
  .strict();

export const runResultSchema = z
  .object({
    capture: z
      .object({
        stderr: runOutputCaptureSchema,
        stdout: runOutputCaptureSchema,
      })
      .strict()
      .optional(),
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
