import type { ProgressView } from "@/application/progress";
import { ACTIVE_CASE_STATES, type CaseState } from "@/domain/case";

import { ProgressRefresh } from "./progress-refresh";

const phaseLabels: Readonly<Record<CaseState, string>> = {
  BLOCKED: "Blocked",
  CANCELLED: "Cancelled",
  DRAFT: "Queued",
  EXPERIMENTING: "Experimenting",
  HYPOTHESIZING: "Hypothesizing",
  INGESTING: "Ingesting",
  INSPECTING: "Inspecting",
  MINIMIZING: "Minimizing",
  NOT_REPRODUCED: "Not reproduced",
  PACKAGING: "Packaging",
  UNSTABLE: "Unstable",
  VERIFIED: "Verified",
  VERIFYING: "Verifying",
};

export function DurableProgressPanel({
  autoRefresh = true,
  progress,
}: {
  autoRefresh?: boolean;
  progress: ProgressView;
}) {
  const activeIndex = ACTIVE_CASE_STATES.indexOf(
    progress.phase as (typeof ACTIVE_CASE_STATES)[number],
  );

  return (
    <section
      className="durable-progress-card"
      data-progress-phase={progress.phase}
      data-progress-state={progress.state}
      aria-labelledby="durable-progress-heading"
    >
      {autoRefresh ? <ProgressRefresh terminal={progress.terminal} /> : null}
      <div className="durable-progress-heading">
        <div>
          <p className="account-label">Durable job state</p>
          <h2 id="durable-progress-heading">{phaseLabels[progress.phase]}</h2>
        </div>
        <span className={`durable-state-pill is-${progress.state.toLowerCase()}`}>
          {progress.state}
        </span>
      </div>
      <ol className="durable-progress-track" aria-label="Reproduction phases">
        {ACTIVE_CASE_STATES.map((phase, index) => {
          const current = phase === progress.phase;
          const complete = progress.terminal || (activeIndex >= 0 && index < activeIndex);
          return (
            <li
              className={`${current ? "is-current" : ""}${complete ? " is-complete" : ""}`.trim()}
              key={phase}
              aria-current={current ? "step" : undefined}
            >
              <span aria-hidden="true">{complete ? "✓" : index + 1}</span>
              {phaseLabels[phase]}
            </li>
          );
        })}
      </ol>
      <p className="durable-progress-status" aria-live="polite">
        {progress.terminal
          ? `Job ${progress.state.toLowerCase()} in ${phaseLabels[progress.phase].toLowerCase()} state.`
          : `${phaseLabels[progress.phase]} · Attempt ${progress.attempt}. This page refreshes automatically.`}
      </p>
      {progress.failure ? (
        <div className="durable-failure" role="alert">
          <strong>{progress.failure.code}</strong>
          <span>{progress.failure.message}</span>
          <small>{progress.failure.retryable ? "Retryable" : "Not retryable"}</small>
        </div>
      ) : null}
    </section>
  );
}
