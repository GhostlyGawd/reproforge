import { describe, expect, it } from "vitest";

import { ResponsesInvestigator } from "@/ai/responses-investigator";
import { investigatorTools } from "@/ai/tools";
import type {
  InvestigatorResponse,
  InvestigatorResponseRequest,
  ResponsesTransport,
} from "@/ai/transport";

import fixture from "./fixtures/openai/investigation-turns.json";

class RecordedTransport implements ResponsesTransport {
  readonly requests: InvestigatorResponseRequest[] = [];
  private cursor = 0;

  async create(request: InvestigatorResponseRequest): Promise<InvestigatorResponse> {
    this.requests.push(structuredClone(request));
    const response = fixture.responses[this.cursor];
    if (!response) {
      throw new Error("Recorded transport exhausted");
    }
    this.cursor += 1;
    return structuredClone(response) as InvestigatorResponse;
  }
}

const input = {
  issue: "The CLI fails with ENOENT when the config path contains spaces.",
  maxToolCalls: 4,
  repository: "fixture://cli-spaces",
};

describe("Responses investigator", () => {
  it("uses the pinned GPT-5.6 request contract and recorded tool turns", async () => {
    const transport = new RecordedTransport();
    const investigator = new ResponsesInvestigator(transport);

    const plan = await investigator.investigate(input);
    const firstRequest = transport.requests[0];

    expect(firstRequest).toMatchObject({
      model: "gpt-5.6-sol",
      parallel_tool_calls: false,
      reasoning: { effort: "medium" },
      store: false,
      tool_choice: "auto",
    });
    expect(firstRequest?.instructions).toContain("Never decide VERIFIED");
    expect(plan).toMatchObject({
      mode: "live",
      model: "gpt-5.6-sol",
      summary:
        "Argument quoting is the leading falsifiable hypothesis; run the allowlisted spaced-path recipe against its control.",
      toolCalls: 3,
    });
    expect(plan.evidence).toHaveLength(1);
    expect(plan.hypotheses).toHaveLength(1);
    expect(plan.experiments).toHaveLength(1);
  });

  it("preserves reasoning and function-call output items during continuation", async () => {
    const transport = new RecordedTransport();
    await new ResponsesInvestigator(transport).investigate(input);

    const continuedInput = transport.requests[1]?.input ?? [];
    expect(continuedInput).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "reasoning", id: "reasoning_recorded_1" }),
        expect.objectContaining({
          type: "function_call",
          call_id: "call_evidence_1",
        }),
        expect.objectContaining({
          type: "function_call_output",
          call_id: "call_evidence_1",
        }),
      ]),
    );
  });

  it("fails closed when a response exceeds the allowed tool-call budget", async () => {
    const transport = new RecordedTransport();
    const investigator = new ResponsesInvestigator(transport);

    await expect(
      investigator.investigate({ ...input, maxToolCalls: 2 }),
    ).rejects.toThrow("tool-call budget");
  });

  it("exposes only strict, non-executing application tools", () => {
    expect(investigatorTools.map((tool) => tool.name)).toEqual([
      "record_evidence",
      "record_hypothesis",
      "propose_experiment",
    ]);

    investigatorTools.forEach((tool) => {
      expect(tool.strict).toBe(true);
      expect(tool.parameters.additionalProperties).toBe(false);
      expect(new Set(tool.parameters.required)).toEqual(
        new Set(Object.keys(tool.parameters.properties)),
      );
      expect(JSON.stringify(tool)).not.toMatch(/shell|publish|network|secret/i);
    });
  });
});
