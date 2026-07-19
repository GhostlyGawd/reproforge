import { z } from "zod";

import { investigationInputSchema } from "@/ai/contracts";
import { createInvestigator, MissingOpenAIKeyError } from "@/ai/factory";

export const runtime = "nodejs";

const requestSchema = investigationInputSchema.extend({
  mode: z.enum(["offline", "live"]).default("offline"),
});

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as unknown;
    const { mode, ...input } = requestSchema.parse(body);
    const investigator = createInvestigator({ mode });
    const plan = await investigator.investigate(input);
    return Response.json(plan);
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError) {
      return Response.json({ error: "Invalid investigation request" }, { status: 400 });
    }
    if (error instanceof MissingOpenAIKeyError) {
      return Response.json(
        { error: "Live GPT-5.6 investigation is not configured" },
        { status: 503 },
      );
    }
    return Response.json({ error: "Investigation failed safely" }, { status: 500 });
  }
}
