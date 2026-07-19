import type { Hypothesis } from "@/domain/evidence";

import { StatusPill } from "./status-pill";

type HypothesisLedgerProps = {
  hypotheses: Hypothesis[];
};

export function HypothesisLedger({ hypotheses }: HypothesisLedgerProps) {
  return (
    <section className="panel" aria-labelledby="hypothesis-heading">
      <header className="panel-header">
        <div>
          <p className="section-kicker">Hypothesis ledger</p>
          <h2 id="hypothesis-heading">Every theory is falsifiable</h2>
        </div>
        <span className="panel-meta">ranked</span>
      </header>
      <ol className="hypothesis-list">
        {hypotheses.map((hypothesis, index) => (
          <li className="hypothesis-item" key={hypothesis.id}>
            <span className="hypothesis-number">H{index + 1}</span>
            <div>
              <p className="hypothesis-statement">{hypothesis.statement}</p>
              <p className="hypothesis-signal">
                Falsified when: {hypothesis.falsificationCondition}
              </p>
            </div>
            <StatusPill
              label={hypothesis.status}
              tone={hypothesis.status === "supported" ? "success" : "warning"}
            />
          </li>
        ))}
      </ol>
    </section>
  );
}
