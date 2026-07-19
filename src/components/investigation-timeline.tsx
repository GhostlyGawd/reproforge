import { CircleCheck } from "lucide-react";

import type { RunResult } from "@/domain/run";

type InvestigationTimelineProps = {
  runs: RunResult[];
};

export function InvestigationTimeline({ runs }: InvestigationTimelineProps) {
  return (
    <section aria-labelledby="timeline-heading">
      <div className="timeline-head">
        <div>
          <p className="section-kicker">Run log</p>
          <h2 id="timeline-heading">Control + repeat verification</h2>
        </div>
        <span className="panel-meta">same environment</span>
      </div>
      <ol className="run-list">
        {runs.map((run, index) => (
          <li className="run-item" key={run.id}>
            <span className="run-index">{index === 0 ? "CONTROL" : `RUN 0${index}`}</span>
            <span className="run-command">{run.command}</span>
            <span className="run-signal">
              <CircleCheck size={12} aria-hidden="true" />
              {index === 0 ? "passed" : "matched"}
            </span>
            <span className="run-exit">exit {run.exitCode}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
