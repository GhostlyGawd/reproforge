import assert from "node:assert/strict";

import { Given, Then, When } from "@cucumber/cucumber";

import {
  toReproductionProgress,
  type ProgressView,
} from "@/application/progress";
import type { ReproductionSnapshot } from "@/application/reproduction-contracts";
import { createCase, transitionCase } from "@/domain/case";
import { createJob, transitionJob } from "@/domain/job";
import { toReproductionView } from "@/mcp/contracts";
import type { ReproForgeWorld } from "../support/world";

const AT = new Date("2026-07-20T12:00:00.000Z");

Given(
  "a durable private-beta case is experimenting",
  function (this: ReproForgeWorld) {
    let reproductionCase = createCase("case_private_beta_parity", AT);
    const transitions = [
      "INGESTING",
      "INSPECTING",
      "HYPOTHESIZING",
      "EXPERIMENTING",
    ] as const;
    transitions.forEach((state, index) => {
      reproductionCase = transitionCase(
        reproductionCase,
        state,
        `private beta phase ${state.toLowerCase()}`,
        new Date(AT.getTime() + (index + 1) * 1_000),
      );
    });
    const job = transitionJob(
      createJob("job_private_beta_parity", reproductionCase.id, AT),
      "RUNNING",
      {
        at: new Date(AT.getTime() + 4_000),
        progressPhase: "EXPERIMENTING",
      },
    );
    this.privateBetaSnapshot = {
      case: reproductionCase,
      job,
      result: null,
      sampleId: "cli-spaces",
      schemaVersion: "2.0",
    } satisfies ReproductionSnapshot;
  },
);

When(
  "REST, MCP, widget, and web progress views are projected",
  function (this: ReproForgeWorld) {
    assert.ok(this.privateBetaSnapshot);
    const direct = toReproductionProgress(this.privateBetaSnapshot.job);
    const mcp = toReproductionView(this.privateBetaSnapshot);
    this.privateBetaProgressViews = [
      direct,
      mcp.progress,
      mcp.progress,
      direct,
    ];
  },
);

Then(
  "every product surface reports the same durable progress",
  function (this: ReproForgeWorld) {
    assert.equal(this.privateBetaProgressViews.length, 4);
    const [expected, ...others] = this.privateBetaProgressViews;
    assert.ok(expected);
    others.forEach((progress: ProgressView) =>
      assert.deepEqual(progress, expected),
    );
    assert.equal(expected.phase, "EXPERIMENTING");
    assert.equal(expected.state, "RUNNING");
    assert.equal(expected.terminal, false);
  },
);
