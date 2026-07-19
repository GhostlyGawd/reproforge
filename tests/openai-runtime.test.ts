import { describe, expect, it, vi } from "vitest";

import {
  createInvestigator,
  getInvestigatorAvailability,
  MissingOpenAIKeyError,
} from "@/ai/factory";
import { OfflineInvestigator } from "@/ai/offline-investigator";
import { OpenAIResponsesTransport } from "@/ai/openai-transport";
import type { InvestigatorResponseRequest } from "@/ai/transport";

describe("OpenAI runtime boundary", () => {
  it("reports availability without exposing or requiring the key", () => {
    expect(getInvestigatorAvailability({})).toEqual({
      liveAvailable: false,
      liveModel: "gpt-5.6-sol",
      sampleMode: "offline",
    });
    expect(getInvestigatorAvailability({ OPENAI_API_KEY: "test-key" })).toEqual({
      liveAvailable: true,
      liveModel: "gpt-5.6-sol",
      sampleMode: "offline",
    });
  });

  it("defaults explicitly to offline and refuses live mode without credentials", () => {
    expect(createInvestigator({ env: {}, mode: "offline" })).toBeInstanceOf(
      OfflineInvestigator,
    );
    expect(() => createInvestigator({ env: {}, mode: "live" })).toThrow(
      MissingOpenAIKeyError,
    );
  });

  it("initializes its OpenAI client lazily and reuses it", async () => {
    const create = vi.fn(async () => ({ id: "response", output: [], outputText: "done" }));
    const clientFactory = vi.fn(() => ({ create }));
    const transport = new OpenAIResponsesTransport({
      apiKey: "test-key",
      clientFactory,
    });
    const request = {
      input: [],
      instructions: "test",
      max_output_tokens: 10,
      model: "gpt-5.6-sol",
      parallel_tool_calls: false,
      reasoning: { effort: "medium" },
      store: false,
      text: { verbosity: "low" },
      tool_choice: "auto",
      tools: [],
    } satisfies InvestigatorResponseRequest;

    expect(clientFactory).not.toHaveBeenCalled();
    await transport.create(request);
    await transport.create(request);

    expect(clientFactory).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(2);
  });
});
