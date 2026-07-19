import { z } from "zod";

import type {
  TenantBackupLogEvent,
  TenantBackupLogger,
} from "@/application/tenant-backup";

type LogSink = Readonly<{
  error(line: string): void;
  info(line: string): void;
}>;

const serializedBackupEventSchema = z
  .object({
    artifactCount: z.number().int().nonnegative(),
    at: z.string().datetime(),
    byteCount: z.number().int().nonnegative(),
    caseCount: z.number().int().nonnegative(),
    code: z.string().regex(/^[A-Z][A-Z0-9_]{0,95}$/),
    event: z.enum([
      "tenant-backup.exported",
      "tenant-backup.restored",
      "tenant-backup.verified",
    ]),
    evidenceCount: z.number().int().nonnegative(),
    level: z.enum(["error", "info"]),
    manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
    outcome: z.enum(["failure", "success"]),
    schemaVersion: z.literal("1.0"),
    tenantId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  })
  .strict();

export class JsonTenantBackupLogger implements TenantBackupLogger {
  constructor(private readonly options: { sink?: LogSink } = {}) {}

  emit(rawEvent: TenantBackupLogEvent): void {
    const event = serializedBackupEventSchema.parse({
      artifactCount: rawEvent.artifactCount,
      at: rawEvent.at,
      byteCount: rawEvent.byteCount,
      caseCount: rawEvent.caseCount,
      code: rawEvent.code,
      event: rawEvent.event,
      evidenceCount: rawEvent.evidenceCount,
      level: rawEvent.level,
      manifestSha256: rawEvent.manifestSha256,
      outcome: rawEvent.outcome,
      schemaVersion: "1.0",
      tenantId: rawEvent.tenantId,
    });
    const line = JSON.stringify(event);
    const sink = this.options.sink ?? console;
    if (event.level === "error") sink.error(line);
    else sink.info(line);
  }
}
