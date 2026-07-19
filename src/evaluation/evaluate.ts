import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { runTrustedSample } from "@/application/sample-case";
import { REQUIRED_BUNDLE_FILES } from "@/domain/bundle";
import {
  verificationStatusSchema,
  verifyReproduction,
  type VerificationSummary,
} from "@/domain/verification";

import { evaluationFixtureSchema, type EvaluationFixture } from "./schema";

type EvaluationCaseResult = {
  actualStatus: VerificationSummary["status"];
  category: EvaluationFixture["category"];
  expectedStatus: VerificationSummary["status"];
  id: string;
  passed: boolean;
  reason: string;
  recordedRunDurationMs: number;
  repeatability: number;
};

export type EvaluationReport = {
  accuracy: number;
  bundleCompleteness: number;
  cases: EvaluationCaseResult[];
  failed: number;
  falseNegatives: number;
  falsePositives: number;
  meanRepeatability: number;
  passed: number;
  schemaVersion: "1.0";
  statusDistribution: Record<VerificationSummary["status"], number>;
  suite: "reproforge-core";
  total: number;
  totalRecordedRunDurationMs: number;
};

function round(value: number): number {
  return Number(value.toFixed(4));
}

async function loadFixtures(directory: string): Promise<EvaluationFixture[]> {
  const filenames = (await readdir(directory))
    .filter((filename) => filename.endsWith(".json"))
    .sort();

  return Promise.all(
    filenames.map(async (filename) => {
      const raw = JSON.parse(await readFile(join(directory, filename), "utf8")) as unknown;
      return evaluationFixtureSchema.parse(raw);
    }),
  );
}

export async function evaluateFixtureDirectory(directory: string): Promise<EvaluationReport> {
  const fixtures = await loadFixtures(directory);
  if (fixtures.length === 0) {
    throw new Error("Evaluation directory contains no JSON fixtures");
  }

  const cases = fixtures.map((fixture): EvaluationCaseResult => {
    const summary = verifyReproduction({
      candidates: fixture.candidates,
      control: fixture.control,
      oracle: fixture.oracle,
    });
    return {
      actualStatus: summary.status,
      category: fixture.category,
      expectedStatus: fixture.expectedStatus,
      id: fixture.id,
      passed: summary.status === fixture.expectedStatus,
      reason: summary.reason,
      recordedRunDurationMs: [fixture.control, ...fixture.candidates].reduce(
        (total, run) => total + run.durationMs,
        0,
      ),
      repeatability: summary.repeatability,
    };
  });
  const sample = await runTrustedSample();
  const presentBundleFiles = REQUIRED_BUNDLE_FILES.filter((file) => file in sample.files).length;
  const passed = cases.filter((evaluation) => evaluation.passed).length;
  const statuses = verificationStatusSchema.options;
  const statusDistribution = Object.fromEntries(
    statuses.map((status) => [
      status,
      cases.filter((evaluation) => evaluation.actualStatus === status).length,
    ]),
  ) as EvaluationReport["statusDistribution"];

  return {
    accuracy: round(passed / cases.length),
    bundleCompleteness: round(presentBundleFiles / REQUIRED_BUNDLE_FILES.length),
    cases,
    failed: cases.length - passed,
    falseNegatives: cases.filter(
      (evaluation) =>
        evaluation.expectedStatus === "VERIFIED" && evaluation.actualStatus !== "VERIFIED",
    ).length,
    falsePositives: cases.filter(
      (evaluation) =>
        evaluation.expectedStatus !== "VERIFIED" && evaluation.actualStatus === "VERIFIED",
    ).length,
    meanRepeatability: round(
      cases.reduce((total, evaluation) => total + evaluation.repeatability, 0) /
        cases.length,
    ),
    passed,
    schemaVersion: "1.0",
    statusDistribution,
    suite: "reproforge-core",
    total: cases.length,
    totalRecordedRunDurationMs: cases.reduce(
      (total, evaluation) => total + evaluation.recordedRunDurationMs,
      0,
    ),
  };
}
