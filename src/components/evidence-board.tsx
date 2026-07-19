import { CircleHelp, Eye, FileText, Lightbulb } from "lucide-react";

import type { EvidenceItem } from "@/domain/evidence";

type EvidenceBoardProps = {
  evidence: EvidenceItem[];
};

const evidenceIcons = {
  inferred: Lightbulb,
  observed: Eye,
  reported: FileText,
  unknown: CircleHelp,
} as const;

export function EvidenceBoard({ evidence }: EvidenceBoardProps) {
  return (
    <section className="panel" aria-labelledby="evidence-heading">
      <header className="panel-header">
        <div>
          <p className="section-kicker">Evidence board</p>
          <h2 id="evidence-heading">Facts stay separate from guesses</h2>
        </div>
        <span className="panel-meta">{evidence.length} items</span>
      </header>
      <div className="evidence-grid">
        {evidence.map((item) => {
          const Icon = evidenceIcons[item.classification];
          return (
            <article className="evidence-card" key={item.id}>
              <div className="evidence-label">
                <span className={`evidence-kind ${item.classification}`}>
                  <Icon size={13} aria-hidden="true" />
                  {item.classification}
                </span>
                <span className="evidence-id">{item.id.replace("evidence-", "E-")}</span>
              </div>
              <p className="evidence-content">{item.content}</p>
              <p className="evidence-source">Source · {item.source}</p>
            </article>
          );
        })}
      </div>
    </section>
  );
}
