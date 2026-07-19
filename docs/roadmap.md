# ReproForge delivery roadmap

Milestones 0–4 below are the completed v1 MVP record. Productization continues in the [v2 roadmap](roadmap-v2.md).

Tasks are grouped into independently reviewable and mergeable milestones. A milestone is complete only when its acceptance evidence is committed and linked from its pull request.

## Milestone 0 — Specification and delivery contract

- [x] `RF-0001` Version the product and technical specification.
- [x] `RF-0002` Record product invariants in repository guidance.
- [x] `RF-0003` Define TDD, property, BDD, browser, and visual-evidence policies.
- [x] `RF-0004` Break delivery into independently verifiable milestones.
- [x] `RF-0005` Record current constraints: public untracked repo, Docker unavailable, no license selected.

**Exit evidence:** documentation link check, clean diff review, and merged pull request.

## Milestone 1 — Deterministic vertical slice

- [x] `RF-1001` Scaffold a strict Next.js 16 TypeScript application with pinned dependencies.
- [x] `RF-1002` Define case, evidence, hypothesis, experiment, run, oracle, and bundle schemas.
- [x] `RF-1003` Implement and property-test the case state machine.
- [x] `RF-1004` Implement and property-test composite failure oracles.
- [x] `RF-1005` Implement control-plus-three-run verification.
- [x] `RF-1006` Implement bundle hashing, redaction, serialization, and validation.
- [x] `RF-1007` Add a trusted fixture runner and an external-runner fail-closed adapter.
- [x] `RF-1008` Execute BDD scenarios for verified, unstable, not-reproduced, and blocked outcomes.

**Exit evidence:** unit, property, BDD, type, lint, and production-build checks.

## Milestone 2 — Golden-path product experience

- [x] `RF-2001` Implement the new-case screen with a one-click trusted sample.
- [x] `RF-2002` Implement the evidence board and hypothesis ledger.
- [x] `RF-2003` Implement the experiment and verification timeline.
- [x] `RF-2004` Implement verified, unstable, blocked, and not-reproduced result states.
- [x] `RF-2005` Implement the downloadable Repro Bundle preview.
- [x] `RF-2006` Add responsive, keyboard, reduced-motion, and automated accessibility coverage.
- [x] `RF-2007` Run browser journeys and capture sanitized desktop and mobile evidence.

**Exit evidence:** browser tests, accessibility scan, build, screenshots, and evidence manifest.

## Milestone 3 — GPT-5.6 investigation boundary

- [x] `RF-3001` Define the investigator interface and deterministic offline implementation.
- [x] `RF-3002` Implement lazy OpenAI client initialization.
- [x] `RF-3003` Integrate `gpt-5.6-sol` through Responses with explicit medium reasoning.
- [x] `RF-3004` Add strict evidence/hypothesis/tool schemas and continuation handling.
- [x] `RF-3005` Add prompt contract and permission-boundary tests.
- [x] `RF-3006` Add recorded contract fixtures that require no network or API key.
- [x] `RF-3007` Surface offline/live mode truthfully in the UI and documentation.

**Exit evidence:** contract tests, offline golden path, type/lint/build, and optional live smoke test when a key is available.

## Milestone 4 — Evaluation, CI, and productization

- [x] `RF-4001` Add a machine-readable evaluation fixture format and benchmark command.
- [x] `RF-4002` Include positive, negative, unstable, and misleading cases.
- [x] `RF-4003` Add GitHub Actions for all required checks.
- [x] `RF-4004` Complete five-minute setup, architecture, limitations, security, and privacy docs.
- [x] `RF-4005` Add real product screenshots and an architecture fallback image.
- [x] `RF-4006` Add provenance, contribution, support, and release-status guidance without inventing a license or release.
- [x] `RF-4007` Run the end-to-end completion audit against the spec and Build Week criteria.

**Exit evidence:** CI results, benchmark report, final browser evidence, complete README, and merged pull request.

## Deferred backlog

- [ ] Docker or managed sandbox execution for external repositories.
- [ ] GitHub App authentication and private repository support.
- [ ] Playwright-based browser defect reproduction.
- [ ] Python, Go, Rust, Java, and multi-repository adapters.
- [ ] Evidence-reviewed issue comments and reproduction-only branches.
- [ ] Parallel hypothesis exploration after baseline evals justify it.

