import type { HealthKind, HealthService } from "@/application/health";

const HEALTH_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
} as const;

export function createHealthHandler(service: HealthService, kind: HealthKind) {
  return async function GET(request: Request): Promise<Response> {
    const requestId =
      request.headers.get("x-vercel-id") ??
      request.headers.get("x-request-id") ??
      undefined;
    const report = await service[kind]({ requestId });
    return Response.json(report, {
      headers: {
        ...HEALTH_HEADERS,
        ...(report.status === "unavailable" ? { "Retry-After": "5" } : {}),
      },
      status: report.status === "ready" ? 200 : 503,
    });
  };
}
