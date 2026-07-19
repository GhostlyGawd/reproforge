"use client";

import {
  Check,
  CircleSlash2,
  Clipboard,
  ClipboardCheck,
  ShieldAlert,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useState } from "react";

import type { VerificationSummary } from "@/domain/verification";
import { outcomePresentation } from "@/presentation/outcome";

type OutcomeResultProps = {
  command?: string;
  summary: VerificationSummary;
};

const outcomeIcons = {
  blocked: ShieldAlert,
  neutral: CircleSlash2,
  success: ShieldCheck,
  warning: TriangleAlert,
} as const;

export function OutcomeResult({ command, summary }: OutcomeResultProps) {
  const [copied, setCopied] = useState(false);
  const presentation = outcomePresentation(summary.status);
  const Icon = outcomeIcons[presentation.tone];
  const verified = summary.status === "VERIFIED";

  useEffect(() => {
    if (!copied) {
      return;
    }

    const timer = window.setTimeout(() => setCopied(false), 1_600);
    return () => window.clearTimeout(timer);
  }, [copied]);

  async function copyCommand() {
    if (!command) {
      return;
    }

    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <section
      className={`verified-card ${presentation.tone}`}
      aria-labelledby="outcome-heading"
    >
      <span className="verified-icon" aria-hidden="true">
        <Icon size={23} />
      </span>
      <h2 id="outcome-heading">{presentation.heading}</h2>
      <p className="verified-copy">{presentation.copy}</p>
      <div className="verification-metrics">
        <span className="verification-metric">
          <Check size={14} aria-hidden="true" />
          {summary.candidateMatches} / {summary.requiredRuns} candidate runs matched
        </span>
        <span className="verification-metric">
          <Check size={14} aria-hidden="true" />
          {summary.controlMatched ? "Negative control matched" : "Negative control passed"}
        </span>
        <span className="verification-metric">
          <Check size={14} aria-hidden="true" />
          {verified ? "Oracle evaluated deterministically" : summary.reason}
        </span>
      </div>
      {verified ? (
        <>
          <div className="signature">
            <span className="signature-label">Failure signature</span>
            <code>ENOENT</code>
          </div>
          {command ? (
            <div className="command-block">
              <code>{command}</code>
              <button
                className="copy-button"
                type="button"
                onClick={copyCommand}
                aria-label={copied ? "Command copied" : "Copy reproduction command"}
              >
                {copied ? (
                  <ClipboardCheck size={14} aria-hidden="true" />
                ) : (
                  <Clipboard size={14} aria-hidden="true" />
                )}
              </button>
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
