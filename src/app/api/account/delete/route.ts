import { getDefaultAccountContext } from "@/account/default-context";
import { createAccountDeletionHandler } from "@/account/handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    const context = await getDefaultAccountContext();
    if (context.status !== "ready") {
      return createAccountDeletionHandler({
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
    return createAccountDeletionHandler({
      actor: async () => context.scope,
      service: context.service,
    })(request);
  } catch {
    return Response.json(
      {
        data: null,
        error: {
          code: "ACCOUNT_DELETION_UNAVAILABLE",
          message: "The account deletion request is temporarily unavailable",
          retryable: true,
        },
        schemaVersion: "1.0",
      },
      { headers: { "Cache-Control": "no-store" }, status: 503 },
    );
  }
}
