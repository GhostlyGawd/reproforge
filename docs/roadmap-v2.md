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

- [ ] `RF-7001` Register the widget resource and three narrow MCP tools.
- [ ] `RF-7002` Add Streamable HTTP at `/mcp` with protocol-safe error handling.
- [ ] `RF-7003` Add accurate schemas, safety annotations, status metadata, and idempotent handlers.
- [ ] `RF-7004` Build the accessible, responsive evidence/proof widget using the MCP Apps bridge.
- [ ] `RF-7005` Prove the complete MCP journey succeeds with `OPENAI_API_KEY` absent.
- [ ] `RF-7006` Add initialize/discovery/resource/call/retry protocol tests.
- [ ] `RF-7007` Add widget BDD/browser/accessibility coverage and sanitized visual evidence.
- [ ] `RF-7008` Document local MCP inspection, reachable-HTTPS developer mode, and plugin packaging.
- [ ] `RF-7009` After the user creates a developer-mode app, scaffold and validate the local plugin using its real `plugin_asdk_app...` ID.

**Exit evidence:** MCP protocol transcript, no-key contract proof, browser screenshots/manifests, automated checks, CI, and—when account-side prerequisites exist—a real ChatGPT developer-mode smoke.

## Milestone 8 — Persistence, authentication, and isolated execution

Tracking: [#13](https://github.com/GhostlyGawd/reproforge/issues/13)

- [ ] `RF-8001` Select and provision durable database, queue, and object storage through a reviewed infrastructure decision.
- [ ] `RF-8002` Implement transactional case/job repositories, migrations, leases, recovery, and backups.
- [ ] `RF-8003` Implement OAuth 2.1/PKCE, tenant identity, and per-tool scopes.
- [ ] `RF-8004` Implement least-privilege GitHub App installation and repository authorization.
- [ ] `RF-8005` Implement a separately isolated external runner and artifact transfer protocol.
- [ ] `RF-8006` Enforce resource, network, process, secret, output, and duration limits.
- [ ] `RF-8007` Implement cancellation, retries, quotas, retention/deletion, and abuse controls.
- [ ] `RF-8008` Add observability, runbooks, restore tests, tenant-isolation tests, and sandbox security tests.
- [ ] `RF-8009` Verify public- and private-repository canaries without weakening the trusted fixture.

**Exit evidence:** threat model, migrations, recovery/restore proof, auth E2E, sandbox controls, canary bundles, operational dashboards/runbooks, and CI. Production provisioning requires an explicit deployment decision.

## Milestone 9 — Hosted plugin submission readiness

Tracking: [#14](https://github.com/GhostlyGawd/reproforge/issues/14)

- [ ] `RF-9001` Deploy stable HTTPS MCP, widget, health, and challenge endpoints.
- [ ] `RF-9002` Complete developer-mode testing across supported ChatGPT plan/workspace configurations.
- [ ] `RF-9003` Verify publisher identity and MCP domain.
- [ ] `RF-9004` Finalize CSP, privacy, terms, support, listing copy, logo, and screenshots.
- [ ] `RF-9005` Add five positive and three negative review cases with expected behavior.
- [ ] `RF-9006` Complete security, accessibility, load, latency, failure-mode, and rollback verification.
- [ ] `RF-9007` Prepare the plugin portal draft and submission-readiness audit.
- [ ] `RF-9008` Obtain explicit go/no-go approval before public submission and publication.

**Exit evidence:** stable hosted test report, domain/publisher evidence, complete review pack, launch/rollback checklist, and recorded approval decision.

## Completion policy

A checked task means working behavior and evidence, not file presence. Milestones 5–7 can be completed locally except for the account-side ChatGPT smoke and plugin app ID, which are recorded separately if unavailable. Milestones 8–9 are not complete until their external infrastructure, security, account, legal, and publication gates have been exercised; mocks cannot satisfy those exits.

