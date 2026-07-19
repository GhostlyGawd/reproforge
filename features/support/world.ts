import { World, setWorldConstructor } from "@cucumber/cucumber";

import type { FailureOracle } from "@/domain/oracle";
import type { RunResult } from "@/domain/run";
import type { VerificationSummary } from "@/domain/verification";
import type { SampleCaseResult } from "@/application/sample-case";

export class ReproForgeWorld extends World {
  candidates: RunResult[] = [];
  control?: RunResult;
  executionBlocked = false;
  oracle?: FailureOracle;
  summary?: VerificationSummary;
  sample?: SampleCaseResult;
}

setWorldConstructor(ReproForgeWorld);
