import { getTrustedWebSnapshot } from "@/application/default-case-service";
import {
  toReproductionView,
  toReproductionWidgetMeta,
} from "@/mcp/contracts";
import { createReproForgeWidgetHtml } from "@/mcp/widget";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const snapshot = await getTrustedWebSnapshot();
  const widgetMeta = toReproductionWidgetMeta(snapshot);
  const html = createReproForgeWidgetHtml({
    structuredContent: toReproductionView(snapshot),
    _meta: {
      reproforge: {
        ...widgetMeta,
        files: snapshot.result?.files ?? {},
      },
    },
  });
  return new Response(html, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/html; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
