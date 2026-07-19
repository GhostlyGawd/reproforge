import assert from "node:assert/strict";

import { After, Given, Then, When } from "@cucumber/cucumber";

import { CaseService, CaseServiceError } from "@/application/case-service";
import { runTrustedSample } from "@/application/sample-case";
import type { RunResult } from "@/domain/run";
import { minimizeReproduction } from "@/domain/minimization";
import { verifyReproduction } from "@/domain/verification";
import { validateMaterializedBundle } from "@/domain/bundle";
import {
  ExternalRunnerUnavailable,
  UnavailableExternalRunner,
} from "@/infrastructure/runner";
import { InMemoryReproductionRepository } from "@/infrastructure/reproduction-repository";
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

function createBddService(world: ReproForgeWorld): CaseService {
  let caseSequence = 0;
  let jobSequence = 0;
  return new CaseService({
    clock: { now: () => new Date("2026-07-19T19:00:00.000Z") },
    executeTrustedSample: async (options) => {
      world.trustedExecutionCount += 1;
      return runTrustedSample(options);
    },
    identifiers: {
      nextCaseId: () => `bdd-case-${++caseSequence}`,
      nextJobId: () => `bdd-job-${++jobSequence}`,
    },
    repository: new InMemoryReproductionRepository(),
  });
}

After(function (this: ReproForgeWorld) {
  if (!this.openAIKeyWasChanged) return;
  if (this.previousOpenAIKey === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = this.previousOpenAIKey;
  }
});

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

Given(
  "a subscription-first trusted ReproForge service",
  function (this: ReproForgeWorld) {
    this.caseService = createBddService(this);
    this.serviceErrorCode = undefined;
    this.serviceStarts = [];
    this.trustedExecutionCount = 0;
  },
);

Given("no OpenAI API key is configured", function (this: ReproForgeWorld) {
  this.previousOpenAIKey = process.env.OPENAI_API_KEY;
  this.openAIKeyWasChanged = true;
  delete process.env.OPENAI_API_KEY;
});

When(
  "the caller starts the trusted sample twice with idempotency key {string}",
  async function (this: ReproForgeWorld, idempotencyKey: string) {
    assert(this.caseService, "case service is required");
    const command = {
      callerId: "bdd-caller",
      idempotencyKey,
      sampleId: "cli-spaces" as const,
    };
    this.serviceStarts = [
      await this.caseService.startTrustedReproduction(command),
      await this.caseService.startTrustedReproduction(command),
    ];
  },
);

When(
  "the caller reads unknown case {string}",
  async function (this: ReproForgeWorld, caseId: string) {
    assert(this.caseService, "case service is required");
    try {
      await this.caseService.getReproduction({ callerId: "bdd-caller", caseId });
    } catch (error) {
      this.serviceErrorCode =
        error instanceof CaseServiceError ? error.code : "UNEXPECTED_ERROR";
    }
  },
);

When(
  "the caller reuses idempotency key {string} with a different budget",
  async function (this: ReproForgeWorld, idempotencyKey: string) {
    assert(this.caseService, "case service is required");
    await this.caseService.startTrustedReproduction({
      budget: { maxToolCalls: 6, requiredRuns: 3 },
      callerId: "bdd-caller",
      idempotencyKey,
      sampleId: "cli-spaces",
    });
    try {
      await this.caseService.startTrustedReproduction({
        budget: { maxToolCalls: 7, requiredRuns: 3 },
        callerId: "bdd-caller",
        idempotencyKey,
        sampleId: "cli-spaces",
      });
    } catch (error) {
      this.serviceErrorCode =
        error instanceof CaseServiceError ? error.code : "UNEXPECTED_ERROR";
    }
  },
);

Then("one trusted reproduction is executed", function (this: ReproForgeWorld) {
  assert.equal(this.trustedExecutionCount, 1);
});

Then(
  "both starts return the same case and job",
  function (this: ReproForgeWorld) {
    assert.equal(this.serviceStarts.length, 2);
    assert.equal(
      this.serviceStarts[0]?.snapshot.case.id,
      this.serviceStarts[1]?.snapshot.case.id,
    );
    assert.equal(
      this.serviceStarts[0]?.snapshot.job.id,
      this.serviceStarts[1]?.snapshot.job.id,
    );
  },
);

Then(
  "the service case state is {string}",
  function (this: ReproForgeWorld, state: string) {
    assert.equal(this.serviceStarts.at(-1)?.snapshot.case.state, state);
  },
);

Then(
  "the service error code is {string}",
  function (this: ReproForgeWorld, code: string) {
    assert.equal(this.serviceErrorCode, code);
  },
);

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
