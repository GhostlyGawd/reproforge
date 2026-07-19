import { defaultCaseService } from "@/application/default-case-service";
import { createReproForgeMcpHttpHandler } from "@/mcp/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handle = createReproForgeMcpHttpHandler({
  callerId: "mcp:anonymous-trusted-sample",
  service: defaultCaseService,
});

export const DELETE = handle;
export const GET = handle;
export const OPTIONS = handle;
export const POST = handle;
export const PUT = handle;
