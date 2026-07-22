import { getDefaultGitHubAuthorizationServices } from "@/github/default-services";
import {
  createGitHubWebhookHandler,
  gitHubWebhookInstallationId,
} from "@/github/webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    const services = await getDefaultGitHubAuthorizationServices();
    return createGitHubWebhookHandler({
      process: async (envelope) => {
        const installationId = gitHubWebhookInstallationId(envelope);
        const installation = installationId
          ? await services.client.readInstallation(installationId)
          : undefined;
        return services.store.processWebhook(
          envelope,
          installation ? { installation } : undefined,
        );
      },
      secret: services.config.credentials.webhookSecret,
    })(request);
  } catch {
    return Response.json(
      { error: "github_webhook_unavailable" },
      { headers: { "Cache-Control": "no-store" }, status: 503 },
    );
  }
}
