# ReproForge v2 delivery roadmap

This roadmap turns the [approved v2 specification](product-spec-v2.md) into independently reviewable milestones. Each milestone is implemented on its own branch and merged only after its acceptance evidence passes.

## Milestone 5 — Platform and transport contract

Tracking: [#10](https://github.com/GhostlyGawd/reproforge/issues/10)

- [x] `RF-5001` Record API-first/plugin-first architecture decision and rejected alternatives.
- [x] `RF-5002` Define the shared application-service, case, and job boundaries.
- [x] `RF-5003` Define versioned REST routes, MCP tools, schemas, annotations, idempotency, and errors.
- [x] `RF-5004` Define subscription-first behavior with no user OpenAI API key.
- [x] `RF-5005` Define widget, auth, privacy, persistence, isolation, operations, and submission gates.
- [x] `RF-5006` Create GitHub milestones/issues for implementation and verification.

**Exit evidence:** approved spec, ADR, roadmap, valid local links, clean documentation review, and CI.

## Milestone 6 — Headless case and job service

Tracking: [#11](https://github.com/GhostlyGawd/reproforge/issues/11)

- [x] `RF-6001` Write failing service/store contract tests before implementation.
- [x] `RF-6002` Add schema-versioned reproduction snapshot and job lifecycle contracts.
- [x] `RF-6003` Implement in-memory repositories with injected clock and identifier seams.
- [x] `RF-6004` Implement caller-scoped idempotent start, conflict detection, read, and export.
- [x] `RF-6005` Route the trusted browser and REST behavior through `CaseService`.
- [x] `RF-6006` Property-test idempotency, lifecycle, serialization, and proof preservation.
- [x] `RF-6007` Add BDD for start, retry, poll, export, conflict, and unknown-case outcomes.
- [x] `RF-6008` Preserve browser, eval, accessibility, and bundle regressions.

**Exit evidence:** the [committed milestone record](evidence/milestone-6/README.md) contains red/green history, unit/property/BDD/browser/eval/build results, a live REST transcript, visual proof, and provenance. CI must also pass on the pull request.

## Milestone 7 — ChatGPT MCP app and embedded widget

Tracking: [#12](https://github.com/GhostlyGawd/reproforge/issues/12)

- [x] `RF-7001` Register the widget resource and three narrow MCP tools.
- [x] `RF-7002` Add Streamable HTTP at `/mcp` with protocol-safe error handling.
- [x] `RF-7003` Add accurate schemas, safety annotations, status metadata, and idempotent handlers.
- [x] `RF-7004` Build the accessible, responsive evidence/proof widget using the MCP Apps bridge.
- [x] `RF-7005` Prove the complete MCP journey succeeds with `OPENAI_API_KEY` absent.
- [x] `RF-7006` Add initialize/discovery/resource/call/retry protocol tests.
- [x] `RF-7007` Add widget BDD/browser/accessibility coverage and sanitized visual evidence.
- [x] `RF-7008` Document local MCP inspection, reachable-HTTPS developer mode, and plugin packaging.
- [ ] `RF-7009` After the user creates a developer-mode app, scaffold and validate the local plugin using its real `plugin_asdk_app...` ID.

**Exit evidence:** the [Milestone 7 record](evidence/milestone-7/README.md) contains the protocol transcript, no-key contract proof, independent Inspector discovery, browser screenshots/manifest, accessibility checks, and test results. CI must pass on the pull request. `RF-7009` and a real ChatGPT-host smoke remain explicitly account-gated until a reachable HTTPS URL and real app ID exist.

## Milestone 8 — Persistence, authentication, and isolated execution

Tracking: [#13](https://github.com/GhostlyGawd/reproforge/issues/13)

- [x] `RF-8001` Select the managed production baseline and provider-neutral seams in [ADR 0002](adr/0002-managed-production-stack.md).
- [x] `RF-8002` Complete [8A durable foundation](specs/milestone-8a-durable-foundation.md): Postgres migrations/repositories, private artifacts, transactional outbox, queue, leases, quotas, retention, audit, health, and restore.
- [ ] `RF-8003` Complete [8B identity and GitHub authorization](specs/milestone-8b-identity-and-github.md): OAuth 2.1/PKCE, tenant/scopes, GitHub App installation, immutable revision authorization, revocation, and secret-safety proof.
- [ ] `RF-8004` Complete [8C isolated execution](specs/milestone-8c-isolated-execution.md): safe source/dependency acquisition, disposable microVM runner, deny-all execution, limits, cancellation, proof integration, and sandbox security tests.
- [ ] `RF-8005` Complete [8D private beta](specs/milestone-8d-private-beta.md): composed staging runtime, resilient async journey, operations, public/private canaries, tenant/abuse audits, and visual evidence.

The authoritative ordered task lists are in the linked specifications and the
[remaining delivery plan](specs/README.md). A parent checkbox is checked only
when every child task and provider-backed gate in that specification passes.

**Exit evidence:** threat model, migrations, recovery/restore proof, auth E2E, sandbox controls, canary bundles, operational dashboards/runbooks, and CI. Real provider evidence is required; mocks cannot close provider tasks.

## Milestone 9 — Hosted plugin submission readiness

Tracking: [#14](https://github.com/GhostlyGawd/reproforge/issues/14)

- [ ] `RF-9001` Complete hosted integration tasks `RF-9101`–`RF-9106` in the [Milestone 9 specification](specs/milestone-9-hosted-launch.md): stable HTTPS, domain/auth callbacks, hosted smoke, real developer app ID, local plugin wrapper, and ChatGPT coverage.
- [ ] `RF-9002` Complete review/readiness tasks `RF-9201`–`RF-9209`: public policy/listing assets, exactly five positive and three negative cases, security, accessibility, load, failure, cost, operations, rollback, portal draft, and final audit.
- [ ] `RF-9003` Complete `RF-9210`: record explicit owner go/no-go approval before any portal submission or publication.

**Exit evidence:** stable hosted test report, domain/publisher evidence, complete review pack, launch/rollback checklist, and recorded approval decision.

## Completion policy

A checked task means working behavior and evidence, not file presence. Milestones 5–7 can be completed locally except for the account-side ChatGPT smoke and plugin app ID, which are recorded separately if unavailable. Milestones 8–9 are not complete until their external infrastructure, security, account, legal, and publication gates have been exercised; mocks cannot satisfy those exits.

