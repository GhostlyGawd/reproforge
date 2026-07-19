import { randomUUID } from "node:crypto";

import { z } from "zod";

import { CaseService, CaseServiceError } from "@/application/case-service";

const API_SCHEMA_VERSION = "2.0" as const;
const TRUSTED_CALLER = "rest:anonymous-trusted-sample";

const startBodySchema = z
  .object({
    budget: z
      .object({
        maxToolCalls: z.number().int().min(1).max(20).optional(),
        requiredRuns: z.number().int().min(1).max(5).optional(),
      })
      .strict()
      .optional(),
    sampleId: z.literal("cli-spaces"),
  })
  .strict();

type NextRequestId = () => string;
type RouteContext<T extends string> = { params: Promise<Record<T, string>> };

function errorStatus(error: CaseServiceError): number {
  switch (error.code) {
    case "NOT_FOUND":
      return 404;
    case "IDEMPOTENCY_CONFLICT":
    case "BUNDLE_NOT_READY":
      return 409;
    case "INTERNAL_ERROR":
      return 500;
  }
}

function success(data: unknown, requestId: string, status = 200): Response {
  return Response.json(
    { data, error: null, requestId, schemaVersion: API_SCHEMA_VERSION },
    { status },
  );
}

function failure(
  requestId: string,
  status: number,
  code: string,
  message: string,
  retryable = false,
): Response {
  return Response.json(
    {
      data: null,
      error: { code, message, retryable },
      requestId,
      schemaVersion: API_SCHEMA_VERSION,
    },
    { status },
  );
}

function mapError(error: unknown, requestId: string): Response {
  if (error instanceof CaseServiceError) {
    return failure(
      requestId,
      errorStatus(error),
      error.code,
      error.message,
      error.retryable,
    );
  }
  if (error instanceof z.ZodError || error instanceof SyntaxError) {
    return failure(requestId, 400, "INVALID_REQUEST", "Invalid request", false);
  }
  return failure(requestId, 500, "INTERNAL_ERROR", "Request failed safely", true);
}

export function createStartReproductionHandler(
  service: CaseService,
  nextRequestId: NextRequestId = randomUUID,
) {
  return async function POST(request: Request): Promise<Response> {
    const requestId = nextRequestId();
    const idempotencyKey = request.headers.get("Idempotency-Key")?.trim();
    if (!idempotencyKey || idempotencyKey.length > 128) {
      return failure(
        requestId,
        400,
        "INVALID_REQUEST",
        "A valid Idempotency-Key header is required",
      );
    }
    try {
      const body = startBodySchema.parse(await request.json());
      const result = await service.startTrustedReproduction({
        budget: body.budget,
        callerId: TRUSTED_CALLER,
        idempotencyKey,
        sampleId: body.sampleId,
      });
      return success(result, requestId, result.reused ? 200 : 201);
    } catch (error) {
      return mapError(error, requestId);
    }
  };
}

export function createGetReproductionHandler(
  service: CaseService,
  nextRequestId: NextRequestId = randomUUID,
) {
  return async function GET(
    _request: Request,
    context: RouteContext<"caseId">,
  ): Promise<Response> {
    const requestId = nextRequestId();
    try {
      const { caseId } = await context.params;
      return success(
        await service.getReproduction({ callerId: TRUSTED_CALLER, caseId }),
        requestId,
      );
    } catch (error) {
      return mapError(error, requestId);
    }
  };
}

export function createGetJobHandler(
  service: CaseService,
  nextRequestId: NextRequestId = randomUUID,
) {
  return async function GET(
    _request: Request,
    context: RouteContext<"jobId">,
  ): Promise<Response> {
    const requestId = nextRequestId();
    try {
      const { jobId } = await context.params;
      return success(
        await service.getJob({ callerId: TRUSTED_CALLER, jobId }),
        requestId,
      );
    } catch (error) {
      return mapError(error, requestId);
    }
  };
}

export function createExportBundleHandler(
  service: CaseService,
  nextRequestId: NextRequestId = randomUUID,
) {
  return async function GET(
    _request: Request,
    context: RouteContext<"caseId">,
  ): Promise<Response> {
    const requestId = nextRequestId();
    try {
      const { caseId } = await context.params;
      return success(
        await service.exportReproBundle({ callerId: TRUSTED_CALLER, caseId }),
        requestId,
      );
    } catch (error) {
      return mapError(error, requestId);
    }
  };
}

