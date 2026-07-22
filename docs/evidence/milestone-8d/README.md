# Milestone 8D evidence

This directory holds sanitized local and hosted evidence for private-beta
completion. Local screenshots prove responsive rendering and accessibility
structure only; they do not substitute for the public/private deployed canary
or live provider gates required by the milestone specification.

Evidence is added incrementally and tied to an exact Git commit in
`manifest.json` before Milestone 8D can be marked complete.

## Current verified slice

Exact implementation commit
`47f893078eac9265c0c6dc4e636ee429135f128a` adds a real isolated-runner
capability probe, fail-closed validation of the complete hosted product
configuration, one durable progress projection shared by REST, MCP, ChatGPT
widget, and tenant-scoped web views, resilient worker/operator controls, the
account data lifecycle, and private-beta operations controls.

The latest productization slice adds a signed-in same-origin web start form
and five real OAuth-protected repository REST routes. The API maps a verified
Auth0 subject to one active durable tenant principal, advertises standards-
shaped linking or incremental-consent challenges, enforces distinct read,
write, bundle, and repository scopes, bounds strict JSON starts to 16 KiB, and
never accepts raw API tokens, URLs, branches, source bodies, or host commands.
Its focused gate passed 10 tests; all 48 BDD scenarios and 345 steps passed,
and TypeScript, ESLint, and the production build passed at the implementation
commit. The sanitized route/scope record is
[`repository-rest-contract.json`](repository-rest-contract.json).

The exact-commit live provider gate then passed all 9 tests across real Neon,
private Blob, Vercel Queue, and Vercel Sandbox in 76.26 seconds. Its first run
found an obsolete assumption about opaque Queue message IDs and a real
recovered-job cancellation defect. A new failing regression reproduced the
defect locally; the corrected version-checked cancellation accepts any legal
queued attempt, and 20 focused cancellation/recovery/retention/Queue tests
pass. The sanitized provider result is
[`local-live-provider-report.json`](local-live-provider-report.json).

The RF-8403 slice blocks new starts during runner degradation while preserving
reads, recovers expired leases, observes cancellation before the next command,
and exposes production-only outbox, lease, and exact-resource quarantine
operations. Its focused resilience gate passed 29 tests, including 500 hostile
operator argument cases.

The RF-8404 slice adds integrity-checked portable account archives,
tenant-scoped export quota, authenticated export and deletion routes, explicit
destructive confirmation, provider-first deletion, retryable retention, and
operator backup/restore commands. Its focused gate passed 17 tests. The broader
governance suite passed 25 tests, including 250 generated retention/deletion
sequences; the backup suite passed 14 tests, including 500 generated portable
archive round trips and mutations.

The RF-8405 slice adds three fail-closed feature kill switches, a
schema-validated identifier-free operations dashboard, eight alerts with an
owner/threshold/runbook/test procedure, structured Vercel runtime health logs,
and an executable expand/contract deployment policy. Its focused gate passed
51 tests; the operations aggregate passed 44 tests, including 500 generated
admission combinations and 500 generated dashboard metric sets. The deployment
policy verifier pins migration `0009_github_event_ordering`, compatibility with
the immediately previous additive schema, and application-only rollback.

The RF-8406 slice adds one schema-closed registry and exact command for eight
deterministic campaigns: load, duplicate delivery, restart, dependency outage,
worker loss, queue lag, storage failure, and sandbox failure. The gate passed
44 tests across 13 files. It includes 128 simultaneous starts plus 128 reads
collapsing to one durable execution, 250 duplicate-delivery schedules, 250
restart/retry sequences, 500 malformed-registry cases, and fixed seeds for
replay. These are local correctness and load-shape results, not hosted latency,
availability, or provider failure-injection evidence.

At this commit, Cucumber passed 48 scenarios and 345 steps, the account page
passed 3 browser tests, TypeScript and ESLint passed, and the production Next.js
build completed. Production-build browser inspection found no framework error
overlay, page errors, console output, or horizontal overflow at a 390 × 844
mobile viewport. The final local account page deliberately shows real controls
disabled while identity configuration is absent.

## Local contract evidence

[`local-operations-dashboard.json`](local-operations-dashboard.json) is the
exact schema-validated synthetic dashboard aggregate used for sanitized local
evidence. It contains no tenant, principal, repository, case, job, provider
resource, source, or object identity. It is not a hosted snapshot and does not
prove alert delivery or a rollback rehearsal.

[`local-resilience-report.json`](local-resilience-report.json) is the
checksummed, fixed-seed RF-8406 campaign summary. It contains synthetic counts
only and does not substitute for the deployed load and failure campaign.

[`local-live-provider-report.json`](local-live-provider-report.json) records
the exact-commit nine-test live Neon, private Blob, Queue, and Sandbox gate. It
contains no provider or tenant identifiers and does not substitute for the
deployed authenticated public/private canaries.

## Local visual evidence

![Desktop ReproForge account data page showing export, explicit deletion confirmation, and retention disclosures in the fail-closed identity setup state.](local-account-data-controls-desktop.png)

![Mobile ReproForge account data page showing responsive export, deletion, and retention controls without horizontal overflow.](local-account-data-controls-mobile.png)

![Desktop ReproForge ChatGPT widget preview showing verified proof, evidence, runs, and bundle state.](local-widget-desktop.png)

![Mobile ReproForge ChatGPT widget preview showing verified proof without horizontal overflow.](local-widget-mobile.png)

![Desktop ReproForge case page showing the tenant-scoped identity boundary while Auth0 is not configured.](local-case-auth-boundary-desktop.png)

![Mobile ReproForge case page showing the tenant-scoped identity boundary without horizontal overflow.](local-case-auth-boundary-mobile.png)

These captures intentionally prove only the local widget presentation,
responsive layout, fail-closed account boundary, and disclosed account-data
controls. They are not proof of a live export or deletion, Auth0, GitHub App,
hosted ChatGPT, or public/private canary journey. Those gates remain open and
keep the milestone status `in-progress`.
