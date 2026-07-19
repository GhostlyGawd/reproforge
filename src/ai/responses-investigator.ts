import type { EvidenceItem, Hypothesis } from "@/domain/evidence";

import {
  investigationInputSchema,
  investigationPlanSchema,
  type ExperimentProposal,
  type Investigator,
  type InvestigationInput,
  type InvestigationPlan,
} from "./contracts";
import {
  investigatorTools,
  proposeExperimentArgumentsSchema,
  recordEvidenceArgumentsSchema,
  recordHypothesisArgumentsSchema,
} from "./tools";
import {
  isFunctionCall,
  type InvestigatorFunctionCall,
  type InvestigatorFunctionCallOutput,
  type InvestigatorResponseItem,
  type ResponsesTransport,
} from "./transport";

export const LIVE_MODEL = "gpt-5.6-sol" as const;

export const INVESTIGATOR_INSTRUCTIONS = [
  "You are ReproForge's evidence investigator.",
  "Turn the submitted issue into sourced evidence, falsifiable hypotheses, and the smallest useful allowlisted experiment proposal.",
  "Use only the provided record and proposal tools. They record artifacts but do not execute anything.",
  "Never decide VERIFIED; deterministic application code owns oracle evaluation, control runs, repeatability, and terminal status.",
  "Do not request credentials, external connectivity, publishing, or source-checkout mutation.",
  "Keep reported, observed, inferred, and unknown evidence distinct.",
  "Return a concise evidence-backed handoff. Do not reveal private chain-of-thought.",
].join(" ");

export class InvestigatorBudgetExceeded extends Error {
  constructor() {
    super("Responses investigator exceeded its tool-call budget");
    this.name = "InvestigatorBudgetExceeded";
  }
}

type Accumulator = {
  evidence: EvidenceItem[];
  experiments: ExperimentProposal[];
  hypotheses: Hypothesis[];
};

function toolOutput(
  call: InvestigatorFunctionCall,
  value: Readonly<Record<string, unknown>>,
): InvestigatorFunctionCallOutput {
  return {
    call_id: call.call_id,
    output: JSON.stringify(value),
    type: "function_call_output",
  };
}

function parseArguments(call: InvestigatorFunctionCall): unknown {
  try {
    return JSON.parse(call.arguments) as unknown;
  } catch {
    return undefined;
  }
}

function executeToolCall(
  call: InvestigatorFunctionCall,
  accumulator: Accumulator,
): InvestigatorFunctionCallOutput {
  const rawArguments = parseArguments(call);
  if (rawArguments === undefined) {
    return toolOutput(call, { accepted: false, error: "Arguments are not valid JSON" });
  }

  if (call.name === "record_evidence") {
    const parsed = recordEvidenceArgumentsSchema.safeParse(rawArguments);
    if (!parsed.success) {
      return toolOutput(call, { accepted: false, error: "Evidence arguments are invalid" });
    }
    if (accumulator.evidence.some((item) => item.id === parsed.data.id)) {
      return toolOutput(call, { accepted: false, error: "Evidence ID already exists" });
    }
    accumulator.evidence.push(parsed.data);
    return toolOutput(call, { accepted: true, id: parsed.data.id });
  }

  if (call.name === "record_hypothesis") {
    const parsed = recordHypothesisArgumentsSchema.safeParse(rawArguments);
    if (!parsed.success) {
      return toolOutput(call, { accepted: false, error: "Hypothesis arguments are invalid" });
    }
    const evidenceIds = new Set(accumulator.evidence.map((item) => item.id));
    if (parsed.data.evidenceIds.some((id) => !evidenceIds.has(id))) {
      return toolOutput(call, {
        accepted: false,
        error: "Hypothesis references evidence that has not been recorded",
      });
    }
    if (accumulator.hypotheses.some((item) => item.id === parsed.data.id)) {
      return toolOutput(call, { accepted: false, error: "Hypothesis ID already exists" });
    }
    accumulator.hypotheses.push({
      ...parsed.data,
      status: "proposed",
      statusHistory: [
        {
          reason: "Recorded by the bounded GPT investigator.",
          sequence: 0,
          status: "proposed",
        },
      ],
    });
    return toolOutput(call, { accepted: true, id: parsed.data.id });
  }

  if (call.name === "propose_experiment") {
    const parsed = proposeExperimentArgumentsSchema.safeParse(rawArguments);
    if (!parsed.success) {
      return toolOutput(call, { accepted: false, error: "Experiment arguments are invalid" });
    }
    if (!accumulator.hypotheses.some((item) => item.id === parsed.data.hypothesisId)) {
      return toolOutput(call, {
        accepted: false,
        error: "Experiment references a hypothesis that has not been recorded",
      });
    }
    if (accumulator.experiments.some((item) => item.id === parsed.data.id)) {
      return toolOutput(call, { accepted: false, error: "Experiment ID already exists" });
    }
    accumulator.experiments.push(parsed.data);
    return toolOutput(call, { accepted: true, id: parsed.data.id });
  }

  return toolOutput(call, { accepted: false, error: "Unknown tool" });
}

function inputMessage(input: {
  issue: string;
  maxToolCalls: number;
  repository: string;
}): InvestigatorResponseItem {
  return {
    type: "message",
    role: "user",
    content: [
      {
        type: "input_text",
        text: JSON.stringify({
          issue: input.issue,
          repository: input.repository,
          toolCallBudget: input.maxToolCalls,
          permittedRecipes: ["control", "reproduce"],
        }),
      },
    ],
  };
}

export class ResponsesInvestigator implements Investigator {
  constructor(private readonly transport: ResponsesTransport) {}

  async investigate(rawInput: InvestigationInput): Promise<InvestigationPlan> {
    const input = investigationInputSchema.parse(rawInput);
    const accumulator: Accumulator = { evidence: [], experiments: [], hypotheses: [] };
    let history: InvestigatorResponseItem[] = [inputMessage(input)];
    let summary = "";
    let toolCalls = 0;
    let completed = false;

    for (let turn = 0; turn <= input.maxToolCalls; turn += 1) {
      const response = await this.transport.create({
        input: history,
        instructions: INVESTIGATOR_INSTRUCTIONS,
        max_output_tokens: 1_800,
        model: LIVE_MODEL,
        parallel_tool_calls: false,
        reasoning: { effort: "medium" },
        store: false,
        text: { verbosity: "low" },
        tool_choice: "auto",
        tools: investigatorTools,
      });
      const calls = response.output.filter(isFunctionCall);

      if (calls.length === 0) {
        summary = response.outputText.trim();
        completed = true;
        break;
      }
      if (toolCalls + calls.length > input.maxToolCalls) {
        throw new InvestigatorBudgetExceeded();
      }

      const outputs = calls.map((call) => executeToolCall(call, accumulator));
      toolCalls += calls.length;
      history = [...history, ...response.output, ...outputs];
    }

    if (!completed) {
      throw new Error("Responses investigator did not complete within its bounded turns");
    }

    return investigationPlanSchema.parse({
      ...accumulator,
      mode: "live",
      model: LIVE_MODEL,
      summary: summary || "Evidence and falsifiable experiment proposals were recorded.",
      toolCalls,
    });
  }
}
