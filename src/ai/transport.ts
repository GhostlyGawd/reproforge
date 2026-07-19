import type { StrictToolDefinition } from "./tools";

export type InvestigatorResponseItem = {
  type: string;
  [key: string]: unknown;
};

export type InvestigatorFunctionCall = InvestigatorResponseItem & {
  arguments: string;
  call_id: string;
  name: string;
  type: "function_call";
};

export type InvestigatorFunctionCallOutput = InvestigatorResponseItem & {
  call_id: string;
  output: string;
  type: "function_call_output";
};

export type InvestigatorResponseRequest = {
  input: InvestigatorResponseItem[];
  instructions: string;
  max_output_tokens: number;
  model: "gpt-5.6-sol";
  parallel_tool_calls: false;
  reasoning: { effort: "medium" };
  store: false;
  text: { verbosity: "low" };
  tool_choice: "auto";
  tools: readonly StrictToolDefinition[];
};

export type InvestigatorResponse = {
  id: string;
  output: InvestigatorResponseItem[];
  outputText: string;
};

export interface ResponsesTransport {
  create(request: InvestigatorResponseRequest): Promise<InvestigatorResponse>;
}

export interface ResponsesClient {
  create(request: InvestigatorResponseRequest): Promise<InvestigatorResponse>;
}

export function isFunctionCall(
  item: InvestigatorResponseItem,
): item is InvestigatorFunctionCall {
  return (
    item.type === "function_call" &&
    typeof item.arguments === "string" &&
    typeof item.call_id === "string" &&
    typeof item.name === "string"
  );
}
