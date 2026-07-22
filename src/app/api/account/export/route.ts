import { createAccountDataExportHandler } from "@/account/handlers";
import { getDefaultAccountContext } from "@/account/default-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request): Promise<Response> {
  try {
    const context = await getDefaultAccountContext();
    if (context.status !== "ready") {
      return createAccountDataExportHandler({
        actor: async () => null,
        service: {
          exportAccountData: async () => {
            throw new Error("Unavailable");
          },
          requestAccountDeletion: async () => {
            throw new Error("Unavailable");
          },
        },
      })(request);
    }
    return createAccountDataExportHandler({
      actor: async () => context.scope,
      service: context.service,
    })(request);
  } catch {
    return Response.json(
      {
        data: null,
        error: {
          code: "ACCOUNT_EXPORT_UNAVAILABLE",
          message: "The account export is temporarily unavailable",
          retryable: true,
        },
        schemaVersion: "1.0",
      },
      { headers: { "Cache-Control": "no-store" }, status: 503 },
    );
  }
}
