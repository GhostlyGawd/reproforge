import { randomUUID } from "node:crypto";

import type {
  AccountDataService,
} from "@/application/account-data-service";
import { AccountDataError } from "@/application/account-data-service";
import type { TenantScope } from "@/application/ports/production";

const SCHEMA_VERSION = "1.0" as const;

type AccountDataOperations = Pick<
  AccountDataService,
  "exportAccountData" | "requestAccountDeletion"
>;

type HandlerDependencies = Readonly<{
  actor(): Promise<TenantScope | null>;
  nextRequestId?: () => string;
  service: AccountDataOperations;
}>;

function json(
  body: unknown,
  status: number,
  headers: Record<string, string> = {},
): Response {
  return Response.json(body, {
    headers: { "Cache-Control": "no-store", ...headers },
    status,
  });
}

function failure(
  requestId: string,
  status: number,
  code: string,
  message: string,
  retryable = false,
): Response {
  return json(
    {
      data: null,
      error: { code, message, retryable },
      requestId,
      schemaVersion: SCHEMA_VERSION,
    },
    status,
  );
}

function mappedFailure(error: unknown, requestId: string): Response {
  if (error instanceof AccountDataError) {
    switch (error.code) {
      case "INVALID_ACCOUNT_DATA_REQUEST":
        return failure(
          requestId,
          400,
          error.code,
          "Invalid account data request",
        );
      case "EXPORT_QUOTA_EXCEEDED":
        return failure(
          requestId,
          429,
          error.code,
          "The account export limit has been reached",
        );
      case "ACCOUNT_EXPORT_UNAVAILABLE":
        return failure(
          requestId,
          503,
          error.code,
          "The account export is temporarily unavailable",
          true,
        );
      case "ACCOUNT_DELETION_UNAVAILABLE":
        return failure(
          requestId,
          503,
          error.code,
          "The account deletion request is temporarily unavailable",
          true,
        );
    }
  }
  if (error instanceof SyntaxError) {
    return failure(requestId, 400, "INVALID_REQUEST", "Invalid request");
  }
  return failure(
    requestId,
    500,
    "INTERNAL_ERROR",
    "The account data request failed safely",
    true,
  );
}

function idempotencyKey(request: Request): string | null {
  const key = request.headers.get("Idempotency-Key")?.trim();
  return key && key.length <= 128 ? key : null;
}

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("Origin");
  if (!origin) return false;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

export function createAccountDataExportHandler(
  dependencies: HandlerDependencies,
) {
  return async function GET(request: Request): Promise<Response> {
    const requestId = (dependencies.nextRequestId ?? randomUUID)();
    const actor = await dependencies.actor().catch(() => null);
    if (!actor) {
      return failure(
        requestId,
        401,
        "AUTHENTICATION_REQUIRED",
        "Sign in to export account data",
      );
    }
    const key = idempotencyKey(request);
    if (!key) {
      return failure(
        requestId,
        400,
        "INVALID_REQUEST",
        "A valid Idempotency-Key header is required",
      );
    }
    try {
      const exported = await dependencies.service.exportAccountData(actor, {
        idempotencyKey: key,
      });
      if (
        !/^reproforge-account-export-\d{4}-\d{2}-\d{2}\.json$/.test(
          exported.filename,
        ) ||
        !/^[a-f0-9]{64}$/.test(exported.sha256) ||
        !/^[a-f0-9]{64}$/.test(exported.manifestSha256)
      ) {
        throw new Error("Invalid account export metadata");
      }
      return new Response(Uint8Array.from(exported.bytes).buffer, {
        headers: {
          "Cache-Control": "no-store",
          "Content-Disposition": `attachment; filename="${exported.filename}"`,
          "Content-Type": exported.contentType,
          ETag: `"${exported.sha256}"`,
          "X-Content-Type-Options": "nosniff",
          "X-ReproForge-Manifest-SHA256": exported.manifestSha256,
        },
        status: 200,
      });
    } catch (error) {
      return mappedFailure(error, requestId);
    }
  };
}

export function createAccountDeletionHandler(
  dependencies: HandlerDependencies,
) {
  return async function POST(request: Request): Promise<Response> {
    const requestId = (dependencies.nextRequestId ?? randomUUID)();
    if (!sameOrigin(request)) {
      return failure(
        requestId,
        403,
        "ORIGIN_REQUIRED",
        "A same-origin request is required",
      );
    }
    const actor = await dependencies.actor().catch(() => null);
    if (!actor) {
      return failure(
        requestId,
        401,
        "AUTHENTICATION_REQUIRED",
        "Sign in to request account deletion",
      );
    }
    const key = idempotencyKey(request);
    if (!key) {
      return failure(
        requestId,
        400,
        "INVALID_REQUEST",
        "A valid Idempotency-Key header is required",
      );
    }
    try {
      const body = (await request.json()) as { confirmation?: unknown };
      const result = await dependencies.service.requestAccountDeletion(actor, {
        confirmation:
          typeof body.confirmation === "string" ? body.confirmation : "",
        idempotencyKey: key,
      });
      return json(
        {
          data: result,
          error: null,
          requestId,
          schemaVersion: SCHEMA_VERSION,
        },
        result.created ? 202 : 200,
      );
    } catch (error) {
      return mappedFailure(error, requestId);
    }
  };
}
