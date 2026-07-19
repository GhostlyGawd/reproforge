import {
  investigationInputSchema,
  investigationPlanSchema,
  type Investigator,
  type InvestigationInput,
  type InvestigationPlan,
} from "./contracts";

export class OfflineInvestigator implements Investigator {
  async investigate(rawInput: InvestigationInput): Promise<InvestigationPlan> {
    const input = investigationInputSchema.parse(rawInput);

    return investigationPlanSchema.parse({
      evidence: [
        {
          classification: "reported",
          content: input.issue,
          id: "evidence-offline-report",
          source: "submitted issue",
        },
        {
          classification: "observed",
          content: "The trusted fixture exposes separate control and reproduce recipes.",
          id: "evidence-offline-fixture",
          source: input.repository,
        },
      ],
      experiments: [
        {
          expectedSignal: "The reproduce recipe exits 1 with ENOENT while control exits 0.",
          hypothesisId: "hypothesis-offline-quoting",
          id: "experiment-offline-spaces",
          rationale: "Change only the path shape while retaining the pinned fixture.",
          recipe: "reproduce",
        },
      ].slice(0, input.maxToolCalls),
      hypotheses: [
        {
          evidenceIds: ["evidence-offline-report", "evidence-offline-fixture"],
          expectedSignal: "The spaced path fails while the control succeeds.",
          falsificationCondition: "Both recipes produce the same successful result.",
          id: "hypothesis-offline-quoting",
          priority: 1,
          statement: "The configuration path is not preserved as one argument.",
          status: "proposed",
          statusHistory: [
            {
              reason: "Recorded by the deterministic offline investigator.",
              sequence: 0,
              status: "proposed",
            },
          ],
        },
      ],
      mode: "offline",
      model: "offline-fixture-v1",
      summary:
        "Argument quoting is the leading falsifiable hypothesis for the trusted sample.",
      toolCalls: 0,
    });
  }
}
