import OpenAI from "openai";
import type { ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses";

import type {
  InvestigatorResponse,
  InvestigatorResponseItem,
  InvestigatorResponseRequest,
  ResponsesClient,
  ResponsesTransport,
} from "./transport";

export type OpenAIClientFactory = (apiKey: string) => ResponsesClient;

function createOpenAIClient(apiKey: string): ResponsesClient {
  const client = new OpenAI({ apiKey });

  return {
    async create(request: InvestigatorResponseRequest): Promise<InvestigatorResponse> {
      const response = await client.responses.create(
        request as unknown as ResponseCreateParamsNonStreaming,
      );

      return {
        id: response.id,
        output: response.output as unknown as InvestigatorResponseItem[],
        outputText: response.output_text,
      };
    },
  };
}

type OpenAIResponsesTransportOptions = {
  apiKey: string;
  clientFactory?: OpenAIClientFactory;
};

export class OpenAIResponsesTransport implements ResponsesTransport {
  private client: ResponsesClient | undefined;
  private readonly clientFactory: OpenAIClientFactory;

  constructor(private readonly options: OpenAIResponsesTransportOptions) {
    this.clientFactory = options.clientFactory ?? createOpenAIClient;
  }

  async create(request: InvestigatorResponseRequest): Promise<InvestigatorResponse> {
    this.client ??= this.clientFactory(this.options.apiKey);
    return this.client.create(request);
  }
}
