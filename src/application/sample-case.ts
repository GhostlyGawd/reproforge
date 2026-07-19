import {
  createBundle,
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
import type { FailureOracle } from "@/domain/oracle";
import type { RunResult } from "@/domain/run";
import {
  verifyReproduction,
  type VerificationSummary,
} from "@/domain/verification";
import { TrustedFixtureRunner } from "@/infrastructure/runner";

export type SampleCaseResult = {
  bundle: ReproBundle;
  case: ReproCase;
  evidence: EvidenceItem[];
  files: Record<string, string>;
  hypotheses: Hypothesis[];
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
    status: "supported",
  },
  {
    id: "hypothesis-node-version",
    statement: "The failure is specific to Node 22 path handling.",
    evidenceIds: ["evidence-report", "evidence-environment"],
    expectedSignal: "The same spaced path succeeds on an earlier runtime.",
    falsificationCondition: "The failure occurs across the pinned supported runtimes.",
    status: "inconclusive",
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
  const summary = verifyReproduction({ oracle, control, candidates });

  let current = createCase("sample-cli-spaces", at(0));
  transitionPath.forEach((transition, index) => {
    current = transitionCase(current, transition.state, transition.reason, at(index + 1));
  });

  const runs = [control, ...candidates];
  const bundle = await createBundle({
    caseId: current.id,
    generatedAt: at(20).toISOString(),
    hypothesisLedger: hypotheses,
    lock: {
      command: "npm run fixture:repro -- --config \"fixtures/my config.json\"",
      environmentHash: "fixture-cli-spaces-v1",
      packageManager: "npm@11",
      repository: "fixture://cli-spaces",
      revision: "fixture-v1",
      runner: "trusted-fixture-v1",
      runtime: "node@24",
    },
    oracle,
    reproductionPatch: [
      "diff --git a/repro/cli-spaces.test.ts b/repro/cli-spaces.test.ts",
      "new file mode 100644",
      "+expect(runCli('--config', 'fixtures/my config.json')).toExitWith(1);",
      "+expect(stderr).toContain('ENOENT');",
      "",
    ].join("\n"),
    runLog: runs,
    summary,
  });

  return {
    bundle,
    case: current,
    evidence,
    files: materializeBundle(bundle),
    hypotheses,
    oracle,
    runs,
    summary,
  };
}
