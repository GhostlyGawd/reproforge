import type { Investigator } from "./contracts";
import { OfflineInvestigator } from "./offline-investigator";
import { OpenAIResponsesTransport } from "./openai-transport";
import { LIVE_MODEL, ResponsesInvestigator } from "./responses-investigator";
import type { ResponsesTransport } from "./transport";

type Environment = Readonly<Record<string, string | undefined>>;

export type InvestigatorAvailability = {
  liveAvailable: boolean;
  liveModel: typeof LIVE_MODEL;
  sampleMode: "offline";
};

export class MissingOpenAIKeyError extends Error {
  constructor() {
    super("Live investigation requires OPENAI_API_KEY");
    this.name = "MissingOpenAIKeyError";
  }
}

export function getInvestigatorAvailability(
  env: Environment = process.env,
): InvestigatorAvailability {
  return {
    liveAvailable: Boolean(env.OPENAI_API_KEY?.trim()),
    liveModel: LIVE_MODEL,
    sampleMode: "offline",
  };
}

type CreateInvestigatorOptions = {
  env?: Environment;
  mode: "offline" | "live";
  transport?: ResponsesTransport;
};

export function createInvestigator({
  env = process.env,
  mode,
  transport,
}: CreateInvestigatorOptions): Investigator {
  if (mode === "offline") {
    return new OfflineInvestigator();
  }

  const apiKey = env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new MissingOpenAIKeyError();
  }

  return new ResponsesInvestigator(
    transport ?? new OpenAIResponsesTransport({ apiKey }),
  );
}
