import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { toReproductionProgress } from "@/application/progress";
import { DurableProgressPanel } from "@/components/durable-progress-panel";
import { createJob, transitionJob } from "@/domain/job";

describe("durable web progress", () => {
  it("renders the shared snapshot phase with an accessible live status", () => {
    const queued = createJob(
      "job_web_progress",
      "case_web_progress",
      new Date("2026-07-20T12:00:00.000Z"),
    );
    const running = transitionJob(queued, "RUNNING", {
      at: new Date("2026-07-20T12:00:01.000Z"),
      progressPhase: "EXPERIMENTING",
    });
    const markup = renderToStaticMarkup(
      createElement(DurableProgressPanel, {
        autoRefresh: false,
        progress: toReproductionProgress(running),
      }),
    );

    expect(markup).toContain('data-progress-phase="EXPERIMENTING"');
    expect(markup).toContain('data-progress-state="RUNNING"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain("Experimenting");
    expect(markup).toContain("Attempt 1");
  });

  it("renders a sanitized terminal failure", () => {
    const queued = createJob(
      "job_web_failure",
      "case_web_failure",
      new Date("2026-07-20T12:00:00.000Z"),
    );
    const running = transitionJob(queued, "RUNNING", {
      at: new Date("2026-07-20T12:00:01.000Z"),
      progressPhase: "INGESTING",
    });
    const failed = transitionJob(running, "FAILED", {
      at: new Date("2026-07-20T12:00:02.000Z"),
      failure: {
        code: "PROVIDER_FAILED",
        message: "The provider failed safely",
        retryable: true,
      },
      progressPhase: "BLOCKED",
    });
    const markup = renderToStaticMarkup(
      createElement(DurableProgressPanel, {
        autoRefresh: false,
        progress: toReproductionProgress(failed),
      }),
    );

    expect(markup).toContain("The provider failed safely");
    expect(markup).toContain("PROVIDER_FAILED");
  });
});
