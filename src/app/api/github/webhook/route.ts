import { getDefaultGitHubServices } from "@/github/default-services";
import { createGitHubWebhookHandler } from "@/github/webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    const services = await getDefaultGitHubServices();
    return createGitHubWebhookHandler({
      process: (envelope) => services.store.processWebhook(envelope),
      secret: services.config.credentials.webhookSecret,
    })(request);
  } catch {
    return Response.json(
      { error: "github_webhook_unavailable" },
      { headers: { "Cache-Control": "no-store" }, status: 503 },
    );
  }
}
