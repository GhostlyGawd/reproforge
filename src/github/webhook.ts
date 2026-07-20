import { createHmac, timingSafeEqual } from "node:crypto";

const SUPPORTED_EVENTS = new Set(["installation", "installation_repositories"]);
const MAX_WEBHOOK_BYTES = 1024 * 1024;

export function verifyGitHubWebhookSignature(input: {
  body: Uint8Array;
  secret: string;
  signature: string | null | undefined;
}): boolean {
  if (
    !input.signature ||
    !/^sha256=[a-f0-9]{64}$/.test(input.signature) ||
    input.secret.length < 16
  ) {
    return false;
  }
  const expected = Buffer.from(
    `sha256=${createHmac("sha256", input.secret).update(input.body).digest("hex")}`,
  );
  const received = Buffer.from(input.signature);
  return (
    expected.byteLength === received.byteLength &&
    timingSafeEqual(expected, received)
  );
}

export type GitHubWebhookEnvelope = {
  deliveryId: string;
  event: "installation" | "installation_repositories";
  payload: unknown;
};

type GitHubWebhookProcessor = {
  process(
    envelope: GitHubWebhookEnvelope,
  ): Promise<"accepted" | "duplicate">;
  secret: string;
};

function rejection(status = 401): Response {
  return Response.json(
    { error: status === 401 ? "invalid_webhook" : "invalid_payload" },
    { headers: { "Cache-Control": "no-store" }, status },
  );
}

export function createGitHubWebhookHandler({
  process,
  secret,
}: GitHubWebhookProcessor) {
  return async function POST(request: Request): Promise<Response> {
    const contentLength = Number(request.headers.get("content-length") ?? "0");
    const contentType = request.headers.get("content-type") ?? "";
    const deliveryId = request.headers.get("x-github-delivery") ?? "";
    const event = request.headers.get("x-github-event") ?? "";
    const signature = request.headers.get("x-hub-signature-256");
    if (
      !contentType.toLowerCase().startsWith("application/json") ||
      (contentLength > 0 && contentLength > MAX_WEBHOOK_BYTES) ||
      !/^[A-Za-z0-9-]{1,128}$/.test(deliveryId) ||
      !SUPPORTED_EVENTS.has(event) ||
      !signature
    ) {
      return rejection();
    }
    const body = new Uint8Array(await request.arrayBuffer());
    if (
      body.byteLength > MAX_WEBHOOK_BYTES ||
      !verifyGitHubWebhookSignature({ body, secret, signature })
    ) {
      return rejection();
    }
    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder().decode(body));
    } catch {
      return rejection(400);
    }
    const disposition = await process({
      deliveryId,
      event: event as GitHubWebhookEnvelope["event"],
      payload,
    });
    return new Response(null, {
      headers: { "Cache-Control": "no-store" },
      status: disposition === "duplicate" ? 200 : 202,
    });
  };
}
