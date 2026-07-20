import { z } from "zod";

import type { OutboxPublishSummary } from "@/application/outbox-publisher";
import type { LeaseRecoverySummary } from "@/application/ports/production";

const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const providerResourceId = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value));
const positiveInteger = (maximum: number) =>
  z
    .string()
    .regex(/^[1-9][0-9]*$/)
    .transform(Number)
    .pipe(z.number().int().min(1).max(maximum));

const recoverFlags = z
  .object({
    "--limit": positiveInteger(1_000),
  })
  .strict();
const listFlags = z
  .object({
    "--limit": positiveInteger(100),
  })
  .strict();
const resolveFlags = z
  .object({
    "--actor-id": identifier,
    "--attempt-id": identifier,
    "--provider-resource-id": providerResourceId,
    "--resource-type": z.enum(["sandbox", "snapshot"]),
    "--tenant-id": identifier,
  })
  .strict();

export type QuarantineResourceView = Readonly<{
  attemptId: string;
  providerResourceId: string;
  quarantinedAt: string;
  resourceType: "sandbox" | "snapshot";
  tenantId: string;
}>;

export type ResolveQuarantineInput = Readonly<{
  actorId: string;
  attemptId: string;
  providerResourceId: string;
  resourceType: "sandbox" | "snapshot";
  tenantId: string;
}>;

export type OperatorCommandTools = Readonly<{
  listQuarantine(input: { limit: number }): Promise<QuarantineResourceView[]>;
  publishOutbox(): Promise<OutboxPublishSummary>;
  recoverExpiredLeases(input: {
    limit: number;
  }): Promise<LeaseRecoverySummary>;
  resolveQuarantine(
    input: ResolveQuarantineInput,
  ): Promise<{ changed: boolean }>;
}>;

export class OperatorCommandError extends Error {
  readonly code = "INVALID_OPERATOR_COMMAND" as const;

  constructor() {
    super("The operator command is invalid");
    this.name = "OperatorCommandError";
  }
}

function flags(argumentsAfterCommand: readonly string[]): Record<string, string> {
  if (argumentsAfterCommand.length % 2 !== 0) throw new OperatorCommandError();
  const parsed: Record<string, string> = {};
  for (let index = 0; index < argumentsAfterCommand.length; index += 2) {
    const name = argumentsAfterCommand[index];
    const value = argumentsAfterCommand[index + 1];
    if (
      !name?.startsWith("--") ||
      !value ||
      Object.prototype.hasOwnProperty.call(parsed, name)
    ) {
      throw new OperatorCommandError();
    }
    parsed[name] = value;
  }
  return parsed;
}

function parseOrThrow<Output>(schema: z.ZodType<Output>, value: unknown): Output {
  const result = schema.safeParse(value);
  if (!result.success) throw new OperatorCommandError();
  return result.data;
}

export async function runOperatorCommand(
  argv: readonly string[],
  tools: OperatorCommandTools,
): Promise<Readonly<{ command: string; result: unknown }>> {
  const [command, ...rawFlags] = argv;
  if (command === "leases:recover") {
    const input = parseOrThrow(recoverFlags, flags(rawFlags));
    const leaseRecovery = await tools.recoverExpiredLeases({
      limit: input["--limit"],
    });
    const outboxPublish = await tools.publishOutbox();
    return {
      command,
      result: { leaseRecovery, outboxPublish },
    };
  }
  if (command === "outbox:publish") {
    if (rawFlags.length > 0) throw new OperatorCommandError();
    return { command, result: await tools.publishOutbox() };
  }
  if (command === "quarantine:list") {
    const input = parseOrThrow(listFlags, flags(rawFlags));
    return {
      command,
      result: await tools.listQuarantine({ limit: input["--limit"] }),
    };
  }
  if (command === "quarantine:resolve") {
    const input = parseOrThrow(resolveFlags, flags(rawFlags));
    return {
      command,
      result: await tools.resolveQuarantine({
        actorId: input["--actor-id"],
        attemptId: input["--attempt-id"],
        providerResourceId: input["--provider-resource-id"],
        resourceType: input["--resource-type"],
        tenantId: input["--tenant-id"],
      }),
    };
  }
  throw new OperatorCommandError();
}

export function formatOperatorFailure(error: unknown): Readonly<{
  error: { code: string; message: string };
  ok: false;
}> {
  if (error instanceof OperatorCommandError) {
    return {
      ok: false,
      error: { code: error.code, message: error.message },
    };
  }
  return {
    ok: false,
    error: {
      code: "OPERATOR_COMMAND_FAILED",
      message: "The operator command failed",
    },
  };
}
