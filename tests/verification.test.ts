import { describe, expect, it } from "vitest";

import type { FailureOracle } from "@/domain/oracle";
import type { RunResult } from "@/domain/run";
import { verifyReproduction } from "@/domain/verification";

const oracle: FailureOracle = {
  id: "exit-one",
  version: 1,
  root: { type: "exit_code", expected: 1 },
};

function run(id: string, exitCode: number): RunResult {
  return {
    id,
    command: "node repro.mjs",
    durationMs: 1,
    environmentHash: "env-one",
    exitCode,
    stderr: "",
    stdout: "",
  };
}

describe("reproduction verification", () => {
  it("verifies three matching candidates and a non-matching control", () => {
    const result = verifyReproduction({
      oracle,
      control: run("control", 0),
      candidates: [run("one", 1), run("two", 1), run("three", 1)],
    });
    expect(result.status).toBe("VERIFIED");
    expect(result.repeatability).toBe(1);
  });

  it("blocks an oracle that also matches its negative control", () => {
    const result = verifyReproduction({
      oracle,
      control: run("control", 1),
      candidates: [run("one", 1), run("two", 1), run("three", 1)],
    });
    expect(result.status).toBe("BLOCKED");
    expect(result.reason).toContain("control");
  });

  it("marks intermittent candidates unstable", () => {
    const result = verifyReproduction({
      oracle,
      control: run("control", 0),
      candidates: [run("one", 1), run("two", 0), run("three", 1)],
    });
    expect(result.status).toBe("UNSTABLE");
    expect(result.repeatability).toBeCloseTo(2 / 3);
  });

  it("marks zero matching candidates not reproduced", () => {
    const result = verifyReproduction({
      oracle,
      control: run("control", 0),
      candidates: [run("one", 0), run("two", 0), run("three", 0)],
    });
    expect(result.status).toBe("NOT_REPRODUCED");
  });
});

