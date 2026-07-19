import assert from "node:assert/strict";

import { Given, Then, When } from "@cucumber/cucumber";

import type { RunResult } from "@/domain/run";
import { minimizeReproduction } from "@/domain/minimization";
import { verifyReproduction } from "@/domain/verification";
import { runTrustedSample } from "@/application/sample-case";
import { validateMaterializedBundle } from "@/domain/bundle";
import {
  ExternalRunnerUnavailable,
  UnavailableExternalRunner,
} from "@/infrastructure/runner";
import type { ReproForgeWorld } from "../support/world";

function run(id: string, exitCode: number): RunResult {
  return {
    id,
    command: "node repro.mjs",
    durationMs: 1,
    environmentHash: "bdd-env",
    exitCode,
    stderr: "",
    stdout: "",
  };
}

Given(
  "a failure oracle that expects exit code {int}",
  function (this: ReproForgeWorld, exitCode: number) {
    this.oracle = {
      id: "bdd-oracle",
      version: 1,
      root: { type: "exit_code", expected: exitCode },
    };
  },
);

Given(
  "a negative control that exits with code {int}",
  function (this: ReproForgeWorld, exitCode: number) {
    this.control = run("control", exitCode);
  },
);

Given(
  "{int} candidate runs that exit with code {int}",
  function (this: ReproForgeWorld, count: number, exitCode: number) {
    this.candidates = Array.from({ length: count }, (_, index) =>
      run(`candidate-${index + 1}`, exitCode),
    );
  },
);

Given(
  "candidate runs with exit codes {string}",
  function (this: ReproForgeWorld, values: string) {
    this.candidates = values
      .split(",")
      .map((value, index) => run(`candidate-${index + 1}`, Number(value)));
  },
);

When("the reproduction is verified", function (this: ReproForgeWorld) {
  assert(this.oracle, "oracle is required");
  assert(this.control, "control is required");
  this.summary = verifyReproduction({
    oracle: this.oracle,
    control: this.control,
    candidates: this.candidates,
  });
});

Then("the outcome is {string}", function (this: ReproForgeWorld, outcome: string) {
  assert.equal(this.summary?.status, outcome);
});

Then("repeatability is 100 percent", function (this: ReproForgeWorld) {
  assert.equal(this.summary?.repeatability, 1);
});

Given("no isolated external runner is configured", function (this: ReproForgeWorld) {
  this.executionBlocked = false;
});

When(
  "an external repository execution is requested",
  async function (this: ReproForgeWorld) {
    try {
      await new UnavailableExternalRunner().run({
        command: "npm test",
        repository: "https://example.com/untrusted.git",
      });
    } catch (error) {
      this.executionBlocked = error instanceof ExternalRunnerUnavailable;
    }
  },
);

Then(
  "execution is blocked before a command runs",
  function (this: ReproForgeWorld) {
    assert.equal(this.executionBlocked, true);
  },
);

Given("a verified baseline reproduction", function (this: ReproForgeWorld) {
  this.oracle = {
    id: "bdd-minimizer-oracle",
    version: 1,
    root: { type: "exit_code", expected: 1 },
  };
  this.control = run("baseline-control", 0);
  this.candidates = [run("baseline-1", 1), run("baseline-2", 1), run("baseline-3", 1)];
});

Given(
  "a proposed reduction whose control matches the failure",
  function (this: ReproForgeWorld) {
    assert(this.oracle, "oracle is required");
    assert(this.control, "control is required");
    this.minimizationInput = {
      baseline: { candidates: this.candidates, control: this.control },
      oracle: this.oracle,
      proposals: [
        {
          candidates: [
            run("reduction-1", 1),
            run("reduction-2", 1),
            run("reduction-3", 1),
          ],
          control: run("reduction-control", 1),
          description: "Remove the distinction between candidate and control.",
          id: "over-reduced",
          removedInputs: ["control distinction"],
        },
      ],
    };
  },
);

When("ReproForge evaluates the proposed reduction", function (this: ReproForgeWorld) {
  assert(this.minimizationInput, "minimization input is required");
  this.minimization = minimizeReproduction(this.minimizationInput);
});

Then("the baseline is retained", function (this: ReproForgeWorld) {
  assert.equal(this.minimization?.acceptedReductionId, null);
  assert.equal(this.minimization?.claim, "baseline-retained");
});

Given("the trusted CLI spaces sample", function (this: ReproForgeWorld) {
  this.sample = undefined;
});

When(
  "ReproForge completes the sample investigation",
  async function (this: ReproForgeWorld) {
    this.sample = await runTrustedSample();
  },
);

Then("the case state is {string}", function (this: ReproForgeWorld, state: string) {
  assert.equal(this.sample?.case.state, state);
});

Then(
  "the Repro Bundle validates independently",
  function (this: ReproForgeWorld) {
    assert(this.sample, "sample result is required");
    assert.deepEqual(validateMaterializedBundle(this.sample.files), {
      success: true,
      errors: [],
    });
  },
);
