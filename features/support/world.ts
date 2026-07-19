import { World, setWorldConstructor } from "@cucumber/cucumber";

import type { FailureOracle } from "@/domain/oracle";
import type { MinimizationInput, MinimizationResult } from "@/domain/minimization";
import type { RunResult } from "@/domain/run";
import type { VerificationSummary } from "@/domain/verification";
import type { SampleCaseResult } from "@/application/sample-case";
import type { CaseService } from "@/application/case-service";
import type { StartResult } from "@/application/reproduction-contracts";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export class ReproForgeWorld extends World {
  candidates: RunResult[] = [];
  control?: RunResult;
  executionBlocked = false;
  minimizationInput?: MinimizationInput;
  minimization?: MinimizationResult;
  oracle?: FailureOracle;
  summary?: VerificationSummary;
  sample?: SampleCaseResult;
  caseService?: CaseService;
  serviceErrorCode?: string;
  serviceStarts: StartResult[] = [];
  trustedExecutionCount = 0;
  previousOpenAIKey?: string;
  openAIKeyWasChanged = false;
  mcpClient?: Client;
  mcpServer?: McpServer;
  mcpStarts: Array<Record<string, unknown>> = [];
  mcpTools: Array<Record<string, unknown>> = [];
  mcpWidget?: Record<string, unknown>;
}

setWorldConstructor(ReproForgeWorld);
