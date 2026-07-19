import { createHealthHandler } from "@/app/health/handlers";
import { defaultRuntimeHealthService } from "@/infrastructure/operations/runtime-health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = createHealthHandler(defaultRuntimeHealthService, "liveness");
