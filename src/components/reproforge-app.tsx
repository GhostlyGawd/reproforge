"use client";

import {
  ArrowRight,
  Bot,
  Check,
  CircleX,
  CircleDot,
  Code2,
  Fingerprint,
  Gauge,
  GitBranch,
  LoaderCircle,
  LockKeyhole,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  TestTube2,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import type { SampleCaseResult } from "@/application/sample-case";

import { BrandMark } from "./brand-mark";
import { BundlePanel } from "./bundle-panel";
import { EvidenceBoard } from "./evidence-board";
import { HypothesisLedger } from "./hypothesis-ledger";
import { InvestigationTimeline } from "./investigation-timeline";
import { OutcomeResult } from "./outcome-result";

type ReproForgeAppProps = {
  liveInvestigatorAvailable: boolean;
  sample: SampleCaseResult;
};

const stages = ["Inspect", "Hypothesize", "Experiment", "Verify", "Package"] as const;

export function ReproForgeApp({
  liveInvestigatorAvailable,
  sample,
}: ReproForgeAppProps) {
  const [started, setStarted] = useState(false);
  const [activeStep, setActiveStep] = useState(0);
  const [cancelled, setCancelled] = useState(false);
  const isComplete = started && !cancelled && activeStep >= stages.length;

  useEffect(() => {
    if (!started || cancelled || isComplete) {
      return;
    }

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const timer = window.setTimeout(
      () => setActiveStep((step) => step + 1),
      reducedMotion ? 1 : 310,
    );

    return () => window.clearTimeout(timer);
  }, [activeStep, cancelled, isComplete, started]);

  function runSample() {
    setActiveStep(0);
    setCancelled(false);
    setStarted(true);
  }

  function replaySample() {
    setActiveStep(0);
    setCancelled(false);
    setStarted(true);
  }

  function cancelSample() {
    setCancelled(true);
  }

  const activeLabel = stages[Math.min(activeStep, stages.length - 1)];

  return (
    <div className="app-shell">
      <header className="site-header">
        <div className="header-inner">
          <BrandMark />
          <div className="header-meta">
            <Link className="header-repository-link" href="/repositories">
              <GitBranch size={14} aria-hidden="true" />
              Repositories
            </Link>
            <span className="header-divider" aria-hidden="true" />
            <span>Evidence-first debugging</span>
            <span className="header-divider" aria-hidden="true" />
            <span className="mode-indicator">
              <span className="mode-dot" aria-hidden="true" />
              Offline demo
            </span>
          </div>
        </div>
      </header>

      <main className="page-wrap">
        <section className="hero" aria-labelledby="page-title">
          <div>
            <p className="eyebrow">
              <span className="eyebrow-line" aria-hidden="true" />
              Deterministic reproduction engine
            </p>
            <h1 id="page-title">
              Turn a bug report into <span>proof</span>
            </h1>
            <p className="hero-copy">
              ReproForge investigates incomplete issues, tests falsifiable hypotheses, and
              exports a one-command reproduction maintainers can trust.
            </p>
          </div>
          <div className="hero-proof" aria-label="Verification requirements">
            <div className="proof-stat">
              <strong>3×</strong>
              <span>repeat matches</span>
            </div>
            <div className="proof-stat">
              <strong>1×</strong>
              <span>negative control</span>
            </div>
            <div className="proof-stat">
              <strong>0</strong>
              <span>model trust required</span>
            </div>
          </div>
        </section>

        <section className="workspace" aria-label="Reproduction workspace">
          <div className="workspace-topbar">
            <div className="window-dots" aria-hidden="true">
              <span className="window-dot" />
              <span className="window-dot" />
              <span className="window-dot" />
            </div>
            <span>case / {sample.case.id}</span>
            <span>runner / trusted-fixture-v1</span>
          </div>

          <div className="intake">
            <div className="intake-main">
              <p className="section-kicker">New reproduction case</p>
              <h2 className="section-title">Start with the messy report</h2>
              <div className="issue-field">
                <label className="field-label" htmlFor="issue-report">
                  Issue, error, or unexpected behavior
                </label>
                <textarea
                  className="issue-input"
                  id="issue-report"
                  defaultValue="The CLI crashes with ENOENT when --config points to a path containing spaces on Node 22. It works when the same file has no spaces."
                />
              </div>
              <div className="intake-actions">
                {!started || cancelled ? (
                  <button className="primary-button" type="button" onClick={runSample}>
                    <Sparkles size={15} aria-hidden="true" />
                    Run trusted sample
                    <ArrowRight size={14} aria-hidden="true" />
                  </button>
                ) : isComplete ? (
                  <button className="secondary-button" type="button" onClick={replaySample}>
                    <RotateCcw size={14} aria-hidden="true" />
                    Replay trusted sample
                  </button>
                ) : (
                  <>
                    <button className="primary-button" type="button" disabled>
                      <LoaderCircle size={15} aria-hidden="true" />
                      Investigating…
                    </button>
                    <button className="secondary-button" type="button" onClick={cancelSample}>
                      <CircleX size={14} aria-hidden="true" />
                      Cancel investigation
                    </button>
                  </>
                )}
                <span className="safe-note">
                  <LockKeyhole size={13} aria-hidden="true" />
                  Allowlisted fixture · no network
                </span>
              </div>
            </div>

            <aside className="intake-side" aria-label="Investigation context">
              <p className="section-kicker">Bounded context</p>
              <h2 className="section-title">Known before the run</h2>
              <dl className="context-list">
                <div className="context-row">
                  <dt>
                    <GitBranch size={15} aria-hidden="true" />
                    <span>Repository</span>
                  </dt>
                  <dd>fixture://cli-spaces</dd>
                </div>
                <div className="context-row">
                  <dt>
                    <Code2 size={15} aria-hidden="true" />
                    <span>Runtime</span>
                  </dt>
                  <dd>Node 24 · npm 11 · pinned</dd>
                </div>
                <div className="context-row">
                  <dt>
                    <Bot size={15} aria-hidden="true" />
                    <span>Investigator</span>
                  </dt>
                  <dd>
                    Offline sample · GPT-5.6 {liveInvestigatorAvailable ? "available" : "not configured"}
                  </dd>
                </div>
                <div className="context-row">
                  <dt>
                    <Gauge size={15} aria-hidden="true" />
                    <span>Budget</span>
                  </dt>
                  <dd>
                    {sample.budget.maxToolCalls} tool calls · {sample.budget.requiredRuns} clean
                    runs
                  </dd>
                </div>
                <div className="context-row">
                  <dt>
                    <Fingerprint size={15} aria-hidden="true" />
                    <span>Failure oracle</span>
                  </dt>
                  <dd>
                    {sample.oracle.id} v{sample.oracle.version} · exit 1 + ENOENT
                  </dd>
                </div>
              </dl>
            </aside>
          </div>

          <div className="investigation-area">
            <div className="progress-strip" aria-label="Investigation progress">
              {stages.map((stage, index) => {
                const complete = activeStep > index;
                const active = started && !cancelled && !isComplete && activeStep === index;
                return (
                  <div
                    className={`progress-step${complete ? " is-complete" : ""}${active ? " is-active" : ""}`}
                    key={stage}
                  >
                    <span className="step-marker" aria-hidden="true">
                      {complete ? <Check size={11} /> : index + 1}
                    </span>
                    {stage}
                  </div>
                );
              })}
            </div>

            <p className="run-live-region" aria-live="polite">
              {!started
                ? "Ready to investigate the trusted sample."
                : cancelled
                  ? "Investigation cancelled. No more tools will run."
                  : isComplete
                  ? "Investigation complete. Verified reproduction created."
                  : `${activeLabel} phase in progress.`}
            </p>

            {!started ? (
              <div className="idle-state">
                <div className="idle-state-inner">
                  <span className="idle-icon" aria-hidden="true">
                    <CircleDot size={21} />
                  </span>
                  <h2>Evidence appears here</h2>
                  <p>
                    Run the safe sample to watch ReproForge separate facts from guesses,
                    test the failure, and package portable proof.
                  </p>
                </div>
              </div>
            ) : cancelled ? (
              <div className="cancelled-state">
                <div className="idle-state-inner">
                  <span className="cancelled-icon" aria-hidden="true">
                    <CircleX size={22} />
                  </span>
                  <h2>Investigation cancelled</h2>
                  <p>
                    The run stopped at the current boundary. Your issue text is preserved and
                    no bundle was produced.
                  </p>
                </div>
              </div>
            ) : !isComplete ? (
              <div className="working-state">
                <div>
                  <span className="working-glyph" aria-hidden="true">
                    <TestTube2 size={25} />
                  </span>
                  <h2>{activeLabel} in progress</h2>
                  <p>bounded tool call · trusted-fixture-v1</p>
                </div>
              </div>
            ) : (
              <div className="results-grid">
                <div className="results-main">
                  <EvidenceBoard evidence={sample.evidence} />
                  <HypothesisLedger hypotheses={sample.hypotheses} />
                  <InvestigationTimeline runs={sample.runs} />
                </div>
                <aside className="results-aside" aria-label="Verified result and bundle">
                  <OutcomeResult
                    command={sample.bundle.lock.command}
                    summary={sample.summary}
                  />
                  <div className="bundle-spacer" aria-hidden="true" />
                  <BundlePanel bundle={sample.bundle} files={sample.files} />
                </aside>
              </div>
            )}
          </div>
        </section>

        <p className="truth-note footer-truth">
          <ShieldCheck size={14} aria-hidden="true" />
          External repositories remain disabled until an isolated runner is configured.
        </p>
      </main>
    </div>
  );
}
