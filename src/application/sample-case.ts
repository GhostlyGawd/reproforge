import {
  createBundle,
  hashCanonical,
  materializeBundle,
  type ReproBundle,
} from "@/domain/bundle";
import {
  createCase,
  transitionCase,
  type CaseState,
  type ReproCase,
} from "@/domain/case";
import type { EvidenceItem, Hypothesis } from "@/domain/evidence";
import { minimizeReproduction, type MinimizationResult } from "@/domain/minimization";
import type { FailureOracle } from "@/domain/oracle";
import type { RunResult } from "@/domain/run";
import {
  verifyReproduction,
  type VerificationSummary,
} from "@/domain/verification";
import { TrustedFixtureRunner } from "@/infrastructure/runner";

export type SampleCaseResult = {
  budget: {
    maxToolCalls: number;
    requiredRuns: number;
  };
  bundle: ReproBundle;
  case: ReproCase;
  evidence: EvidenceItem[];
  files: Record<string, string>;
  hypotheses: Hypothesis[];
  minimization: MinimizationResult;
  oracle: FailureOracle;
  runs: RunResult[];
  summary: VerificationSummary;
};

const evidence: EvidenceItem[] = [
  {
    id: "evidence-report",
    classification: "reported",
    content: "The CLI crashes when a configuration path contains spaces on Node 22.",
    source: "sample issue #184",
  },
  {
    id: "evidence-stack",
    classification: "reported",
    content: "The reporter observed an ENOENT error while loading the configuration.",
    source: "sample issue stack trace",
  },
  {
    id: "evidence-inspection",
    classification: "observed",
    content: "The CLI forwards the configuration path through a shell command.",
    source: "fixture source inspection",
  },
  {
    id: "evidence-environment",
    classification: "unknown",
    content: "The reporter's shell and exact working directory were not provided.",
    source: "missing issue metadata",
  },
];

const hypotheses: Hypothesis[] = [
  {
    id: "hypothesis-quoting",
    statement: "The configuration path is not preserved as one argument when it contains spaces.",
    evidenceIds: ["evidence-report", "evidence-stack", "evidence-inspection"],
    expectedSignal: "A spaced path exits 1 with ENOENT while the control path exits 0.",
    falsificationCondition: "Both the spaced path and control path load successfully.",
    priority: 1,
    status: "supported",
    statusHistory: [
      { reason: "Created from reported and inspected evidence.", sequence: 0, status: "proposed" },
      { reason: "The control passed and all three candidate runs matched.", sequence: 1, status: "supported" },
    ],
  },
  {
    id: "hypothesis-node-version",
    statement: "The failure is specific to Node 22 path handling.",
    evidenceIds: ["evidence-report", "evidence-environment"],
    expectedSignal: "The same spaced path succeeds on an earlier runtime.",
    falsificationCondition: "The failure occurs across the pinned supported runtimes.",
    priority: 2,
    status: "inconclusive",
    statusHistory: [
      { reason: "Created from the reporter's runtime claim.", sequence: 0, status: "proposed" },
      { reason: "The trusted slice does not vary the runtime.", sequence: 1, status: "inconclusive" },
    ],
  },
];

const oracle: FailureOracle = {
  id: "oracle-cli-spaces",
  version: 1,
  root: {
    type: "all",
    children: [
      { type: "exit_code", expected: 1 },
      { type: "output_contains", stream: "stderr", value: "ENOENT" },
    ],
  },
};

const transitionPath: Array<{ state: CaseState; reason: string }> = [
  { state: "INGESTING", reason: "Loaded the trusted sample issue and fixture." },
  { state: "INSPECTING", reason: "Classified issue and repository evidence." },
  { state: "HYPOTHESIZING", reason: "Created falsifiable hypotheses." },
  { state: "EXPERIMENTING", reason: "Ran the allowlisted control and candidate commands." },
  { state: "VERIFYING", reason: "Evaluated the versioned failure oracle." },
  { state: "MINIMIZING", reason: "Reduced the reproduction to one spaced-path input." },
  { state: "PACKAGING", reason: "Validated the portable Repro Bundle contract." },
  { state: "VERIFIED", reason: "Three candidate runs matched and the control did not." },
];

function at(index: number): Date {
  return new Date(Date.UTC(2026, 6, 19, 16, 0, 0, index));
}
export async function runTrustedSample(): Promise<SampleCaseResult> {
  const runner = new TrustedFixtureRunner();
  const control = {
    ...(await runner.run({ repository: "fixture://cli-spaces", command: "control" })),
    id: "control-1",
  };
  const candidates = await Promise.all(
    [1, 2, 3].map(async (index) => ({
      ...(await runner.run({
        repository: "fixture://cli-spaces",
        command: "reproduce",
      })),
      id: `candidate-${index}`,
    })),
  );
  const baselineSummary = verifyReproduction({ oracle, control, candidates });
  const minimizedControl = {
    ...(await runner.run({ repository: "fixture://cli-spaces", command: "control" })),
    id: "minimized-control",
  };
  const minimizedCandidates = await Promise.all(
    [1, 2, 3].map(async (index) => ({
      ...(await runner.run({ repository: "fixture://cli-spaces", command: "reproduce" })),
      id: `minimized-candidate-${index}`,
    })),
  );
  const minimization = minimizeReproduction({
    baseline: { candidates, control },
    oracle,
    proposals: [
      {
        candidates: minimizedCandidates,
        control: minimizedControl,
        description: "Retain only the spaced configuration path input.",
        id: "spaced-path-only",
        removedInputs: ["reporter shell assumption", "working-directory variation"],
      },
    ],
  });
  const summary =
    minimization.evaluations.find(
      (evaluation) => evaluation.id === minimization.acceptedReductionId,
    )?.summary ?? baselineSummary;

  let current = createCase("sample-cli-spaces", at(0));
  transitionPath.forEach((transition, index) => {
    current = transitionCase(current, transition.state, transition.reason, at(index + 1));
  });

  const runs = [minimizedControl, ...minimizedCandidates];
  const bundle = await createBundle({
    caseId: current.id,
    generatedAt: at(20).toISOString(),
    hypothesisLedger: hypotheses,
    lock: {
      command: "npm run fixture:repro -- --config \"fixtures/cli-spaces/my config.json\"",
      dependencyLockHash: await hashCanonical({ fixture: "cli-spaces", packageManager: "npm@11" }),
      environment: { NETWORK: "denied", NODE_ENV: "test" },
      environmentHash: "fixture-cli-spaces-v1",
      oracleId: oracle.id,
      oracleVersion: oracle.version,
      packageManager: "npm@11",
      repository: "fixture://cli-spaces",
      repositoryTreeHash: await hashCanonical({ fixture: "cli-spaces", revision: "fixture-v1" }),
      reproForgeVersion: "0.1.0",
      revision: "fixture-v1",
      runner: "trusted-fixture-v1",
      runtime: "node@24",
    },
    minimization,
    oracle,
    reproductionPatch: [
      "diff --git a/repro/cli-spaces.test.ts b/repro/cli-spaces.test.ts",
      "new file mode 100644",
      "+expect(runCli('--config', 'fixtures/cli-spaces/my config.json')).toExitWith(1);",
      "+expect(stderr).toContain('ENOENT');",
      "",
    ].join("\n"),
    runLog: runs,
    summary,
  });

  return {
    budget: { maxToolCalls: 6, requiredRuns: 3 },
    bundle,
    case: current,
    evidence,
    files: materializeBundle(bundle),
    hypotheses,
    minimization,
    oracle,
    runs,
    summary,
  };
}
