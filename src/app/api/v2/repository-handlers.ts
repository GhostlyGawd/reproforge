import { randomUUID } from "node:crypto";

import { z } from "zod";

import { CaseServiceError } from "@/application/case-service";
import type { ReproForgeOAuthScope } from "@/application/ports/auth";
import type {
  RepositoryApiAuthorization,
  RepositoryApiAuthorizer,
} from "@/application/ports/http-authorization";
import type { RepositoryPrincipal } from "@/application/ports/repository-source";
import {
  startRepositoryReproductionInputSchema,
  type RepositoryOperations,
} from "@/application/repository-operations";
import { toReproductionProgress } from "@/application/progress";

const API_SCHEMA_VERSION = "2.0" as const;
const MAX_START_BODY_BYTES = 16_384;

export type { RepositoryApiAuthorization, RepositoryApiAuthorizer };

type Dependencies = {
  authorize: RepositoryApiAuthorizer;
  operations: RepositoryOperations;
};

type RouteContext<Key extends string> = {
  params: Promise<Record<Key, string>>;
};

const startBodySchema = startRepositoryReproductionInputSchema.omit({
  idempotencyKey: true,
});

const listQuerySchema = z
  .object({
    cursor: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

class RequestBodyError extends Error {
  constructor(
    readonly code: "PAYLOAD_TOO_LARGE" | "UNSUPPORTED_MEDIA_TYPE",
    readonly status: 413 | 415,
  ) {
    super(code);
    this.name = "RequestBodyError";
  }
}

function acceptsJson(request: Request): boolean {
  return (
    request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ===
    "application/json"
  );
}

async function readBoundedJson(request: Request): Promise<unknown> {
  if (!acceptsJson(request)) {
    throw new RequestBodyError("UNSUPPORTED_MEDIA_TYPE", 415);
  }
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new SyntaxError("Invalid content length");
    }
    if (length > MAX_START_BODY_BYTES) {
      throw new RequestBodyError("PAYLOAD_TOO_LARGE", 413);
    }
  }
  if (!request.body) throw new SyntaxError("Missing request body");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_START_BODY_BYTES) {
      await reader.cancel();
      throw new RequestBodyError("PAYLOAD_TOO_LARGE", 413);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    if (error instanceof SyntaxError) throw error;
    throw new SyntaxError("Invalid JSON encoding");
  }
}

function success(data: unknown, status = 200): Response {
  return Response.json(
    {
      data,
      error: null,
      requestId: randomUUID(),
      schemaVersion: API_SCHEMA_VERSION,
    },
    { headers: { "Cache-Control": "no-store" }, status },
  );
}

function failure(
  status: number,
  code: string,
  message: string,
  retryable = false,
  challenge?: string,
): Response {
  const headers = new Headers({ "Cache-Control": "no-store" });
  if (challenge) headers.set("WWW-Authenticate", challenge);
  return Response.json(
    {
      data: null,
      error: { code, message, retryable },
      requestId: randomUUID(),
      schemaVersion: API_SCHEMA_VERSION,
    },
    { headers, status },
  );
}

function serviceStatus(error: CaseServiceError): number {
  switch (error.code) {
    case "NOT_FOUND":
      return 404;
    case "BUNDLE_NOT_READY":
    case "IDEMPOTENCY_CONFLICT":
      return 409;
    case "EXECUTION_PROFILE_DISABLED":
    case "PRIVATE_REPOSITORIES_DISABLED":
    case "REPOSITORY_STARTS_DISABLED":
    case "RUNNER_UNAVAILABLE":
      return 503;
    case "INTERNAL_ERROR":
      return 500;
  }
}

function safeError(error: unknown): Response {
  if (error instanceof RequestBodyError) {
    return failure(error.status, error.code, "Invalid request");
  }
  if (error instanceof z.ZodError || error instanceof SyntaxError) {
    return failure(400, "INVALID_REQUEST", "Invalid request");
  }
  if (error instanceof CaseServiceError) {
    return failure(
      serviceStatus(error),
      error.code,
      error.message,
      error.retryable,
    );
  }
  return failure(500, "INTERNAL_ERROR", "Request failed safely", true);
}

async function authorize(
  dependencies: Dependencies,
  request: Request,
  scopes: ReproForgeOAuthScope[],
): Promise<RepositoryPrincipal | Response> {
  const result = await dependencies.authorize(request, scopes);
  if (result.ok) return result.principal;
  return failure(
    result.status,
    result.code,
    result.message,
    false,
    result.challenge,
  );
}

export function createStartRepositoryReproductionHandler(
  dependencies: Dependencies,
) {
  return async function POST(request: Request): Promise<Response> {
    const authorized = await authorize(dependencies, request, [
      "reproforge:cases:write",
      "reproforge:repositories:read",
    ]);
    if (authorized instanceof Response) return authorized;
    const idempotencyKey = request.headers.get("idempotency-key")?.trim();
    if (!idempotencyKey || idempotencyKey.length > 128) {
      return failure(
        400,
        "INVALID_REQUEST",
        "A valid Idempotency-Key header is required",
      );
    }
    try {
      const body = startBodySchema.parse(await readBoundedJson(request));
      const started = await dependencies.operations.startRepositoryReproduction(
        authorized,
        { ...body, idempotencyKey },
      );
      return success(
        {
          ...started,
          progress: toReproductionProgress(started.snapshot.job),
        },
        started.reused ? 200 : 201,
      );
    } catch (error) {
      return safeError(error);
    }
  };
}

export function createListAuthorizedRepositoriesHandler(
  dependencies: Dependencies,
) {
  return async function GET(request: Request): Promise<Response> {
    const authorized = await authorize(dependencies, request, [
      "reproforge:repositories:read",
    ]);
    if (authorized instanceof Response) return authorized;
    try {
      const url = new URL(request.url);
      const query = listQuerySchema.parse(Object.fromEntries(url.searchParams));
      const listed = await dependencies.operations.listAuthorizedRepositories(
        authorized,
        query,
      );
      return success({
        nextCursor: listed.nextCursor,
        repositories: listed.repositories,
      });
    } catch (error) {
      return safeError(error);
    }
  };
}

export function createGetRepositoryReproductionHandler(
  dependencies: Dependencies,
) {
  return async function GET(
    request: Request,
    context: RouteContext<"caseId">,
  ): Promise<Response> {
    const authorized = await authorize(dependencies, request, [
      "reproforge:cases:read",
    ]);
    if (authorized instanceof Response) return authorized;
    try {
      const { caseId } = await context.params;
      const snapshot = await dependencies.operations.getReproduction(
        authorized,
        { caseId },
      );
      return success({
        ...snapshot,
        progress: toReproductionProgress(snapshot.job),
      });
    } catch (error) {
      return safeError(error);
    }
  };
}

export function createExportRepositoryBundleHandler(
  dependencies: Dependencies,
) {
  return async function GET(
    request: Request,
    context: RouteContext<"caseId">,
  ): Promise<Response> {
    const authorized = await authorize(dependencies, request, [
      "reproforge:bundles:read",
    ]);
    if (authorized instanceof Response) return authorized;
    try {
      const { caseId } = await context.params;
      return success(
        await dependencies.operations.exportReproBundle(authorized, { caseId }),
      );
    } catch (error) {
      return safeError(error);
    }
  };
}

export function createCancelRepositoryReproductionHandler(
  dependencies: Dependencies,
) {
  return async function POST(
    request: Request,
    context: RouteContext<"jobId">,
  ): Promise<Response> {
    const authorized = await authorize(dependencies, request, [
      "reproforge:cases:write",
    ]);
    if (authorized instanceof Response) return authorized;
    try {
      const { jobId } = await context.params;
      return success(
        await dependencies.operations.cancelReproduction(authorized, { jobId }),
      );
    } catch (error) {
      return safeError(error);
    }
  };
}
