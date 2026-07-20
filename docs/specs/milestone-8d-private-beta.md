# Milestone 8D specification: private-beta completion

- **Status:** in progress; local RF-8401–RF-8405 implementation passed, hosted
  exercises and RF-8406–RF-8411 remain open
- **Parent:** [Milestone 8 issue #13](https://github.com/GhostlyGawd/reproforge/issues/13)
- **Depends on:** durable foundation, identity/GitHub authorization, and isolated execution
- **Unblocks:** stable hosted ChatGPT/plugin testing

## Outcome

Prove the complete authenticated product under realistic restart, duplicate,
failure, retention, restore, and abuse conditions. Close Milestone 8 only after
both a public and private repository canary succeed through the same deployed
staging architecture intended for private beta.

## Private-beta user journey

1. User signs in and links ReproForge from ChatGPT or the web application.
2. User installs the read-only GitHub App on selected repositories.
3. ReproForge lists only authorized repositories.
4. User selects an exact revision, provides issue evidence, chooses a supported
   Node profile, reviews the limits, and starts with an idempotency key.
5. The request returns stable case/job identifiers promptly while work runs
   asynchronously.
6. ChatGPT and the web/widget display the same durable progress phases.
7. User may cancel active work.
8. The terminal state truthfully distinguishes verified, unstable, not
   reproduced, blocked, cancelled, and operational failure.
9. Verified work exports a portable bundle; other outcomes expose evidence but
   never a verified bundle.
10. User can request data export/deletion and inspect the disclosed retention
    behavior.

## Reliability targets

Private-beta targets are product gates, not public service-level promises:

| Signal | Target |
|---|---:|
| MCP/REST non-job request availability during test window | at least 99.5% |
| start acknowledgement p95 | under 2 seconds, excluding account linking |
| read/progress p95 | under 1 second for warm provider dependencies |
| duplicate-start correctness | 100%; one case/job |
| expired-lease recovery | within 2 recovery intervals |
| cancellation observation | before the next command starts, or active command timeout |
| queue age alert | before oldest message exceeds 5 minutes |
| provider secret leakage | zero occurrences |
| cross-tenant authorization failures | zero unauthorized successes |
| backup restore point | complete verified manifest within documented RPO/RTO drill |

The actual measured values and provider plan are recorded in evidence before
these targets can be checked.

## Operations contract

- Separate liveness, dependency readiness, and runner-capability endpoints.
- Structured logs carry request, tenant-safe principal, case, job, attempt,
  queue-delivery, and sandbox identifiers but no source body or secret.
- Metrics cover request latency/errors, OAuth denials, queue depth/age,
  outbox lag, job phase/duration/outcome, retries, leases, sandbox creation and
  cleanup, resource/network use, artifact operations, quota denials, and
  retention/deletion.
- Alerts have an owner, threshold, test procedure, and linked runbook.
- A deployment is unhealthy when required production configuration, database,
  artifact store, or queue is unavailable; runner readiness may independently
  disable repository starts while reads remain available.
- Feature flags can disable new repository starts, private repository access,
  or one execution profile without hiding existing cases.
- Rollback never rolls the database schema backward destructively. Application
  compatibility spans at least the current and immediately previous schema.

## Abuse and privacy contract

- Per-principal, tenant, repository, and global quotas bound starts, concurrent
  jobs, CPU time, storage, and exports.
- Repeated authorization failures, source-limit violations, and malicious
  runner outcomes produce audit/abuse signals without recording payload bodies.
- Denials are stable and reveal no cross-tenant or private-repository detail.
- Source, run, and bundle retention timers are enforced by background deletion
  with retry and evidence.
- Account deletion requires explicit confirmation, revokes new activity,
  cancels active work, deletes customer data, and retains only the documented
  minimal tombstone.
- Backups follow the same access and retention classification as primary data.

## Canary contract

### Public canary

A repository owned for ReproForge testing contains a deterministic issue at a
pinned commit and a later fixed commit. The canary must prove the failing
revision, clear control/fixed revision, three clean runs, and bundle rerun.

### Private canary

A private repository contains equivalent synthetic code and no personal,
customer, or proprietary data. It is installed through the GitHub App, is not
publicized in screenshots/logs, and proves the same outcome. Revoking the
installation after the run must block new starts.

Both canaries use real provider infrastructure. Their code and expected oracle
may be mirrored as sanitized local fixtures, but local fixtures do not replace
the deployed canary evidence.

## Ordered task list

- [ ] `RF-8401` Compose the durable, auth, GitHub, queue, runner, artifact, quota, and audit adapters into one staging runtime with fail-closed configuration.
- [ ] `RF-8402` Implement asynchronous progress snapshots and parity across REST, MCP model output, widget, and web UI.
- [ ] `RF-8403` Implement end-to-end cancellation, bounded retry, expired-lease recovery, provider degradation, and operator retry/quarantine tools with audit events.
- [ ] `RF-8404` Implement retention, export, deletion, and backup/restore jobs plus customer-facing data controls.
- [ ] `RF-8405` Add dashboards, alerts, runbooks, feature kill switches, and a deployment/rollback compatibility policy.
- [ ] `RF-8406` Add deterministic load, duplicate-delivery, restart, dependency-outage, worker-loss, queue-lag, storage-failure, and sandbox-failure test harnesses.
- [ ] `RF-8407` Create and execute the sanitized public repository canary through web, REST, and MCP; rerun the exported bundle independently.
- [ ] `RF-8408` Create and execute the synthetic private repository canary, verify revocation, and keep all captured evidence private-safe.
- [ ] `RF-8409` Run tenant-isolation, authorization, retention, backup/restore, abuse, and secret-leak audits against deployed staging.
- [ ] `RF-8410` Capture accessible desktop/mobile web and widget evidence, protocol transcripts, operational metrics, canary manifests, and checksums.
- [ ] `RF-8411` Update every product/security/privacy/operations/release document and complete the Milestone 8 requirement audit.

The checkboxes remain open until their deployed acceptance evidence passes.
Commit `7c75a8f0131f85ac1987737e5370e49deaa10b7f` is the current local
implementation boundary: RF-8401/RF-8402 still require the live authenticated
hosted journey, RF-8403 still requires the deployed recovery/quarantine drill,
RF-8404 still requires the deployed retention/deletion/restore drill, and
RF-8405 still requires hosted alert delivery plus a deployment/rollback
rehearsal. The sanitized local record is in
[`docs/evidence/milestone-8d`](../evidence/milestone-8d/README.md).

## TDD, property, and BDD requirements

New behavior begins with failing end-to-end or contract tests. State/failure
properties run at least 500 generated event schedules:

- any interleaving of duplicate start, delivery, lease expiry, cancellation,
  provider response, and retry yields one legal terminal state;
- cancellation is monotonic and prevents new commands after observation;
- a dependency outage cannot cause fallback to memory, no-auth, public Blob, or
  host execution;
- progress in REST, MCP, widget, and web is a projection of the same durable
  snapshot and cannot disagree on proof status or bundle hash;
- retention/deletion retry sequences eventually delete eligible objects once
  dependencies recover and never delete another tenant's data;
- backup/restore round-trips preserve schema validity, hashes, terminality, and
  tenant isolation; and
- arbitrary logs/events/metrics remain free of registered synthetic secrets.

```gherkin
Feature: Private-beta ReproForge
  Scenario: A linked user reproduces a public repository from ChatGPT
  Scenario: A linked user reproduces an authorized private repository
  Scenario: The same case is visible consistently in ChatGPT and the web app
  Scenario: A process restart does not lose or duplicate an active job
  Scenario: A worker loss recovers an expired lease
  Scenario: A queue duplicate does not duplicate runs or bundles
  Scenario: A user cancels an active repository job
  Scenario: Runner degradation blocks new starts while completed cases remain readable
  Scenario: A tenant reaches a hard compute quota
  Scenario: A user exports then deletes retained case data
  Scenario: Revoking GitHub installation blocks a new private job
  Scenario: A restored verified case reproduces the same bundle hash
```

## Acceptance and evidence gate

- Every `RF-8401`–`RF-8411` item has direct automated or inspected evidence.
- Public and private canaries complete from real GitHub authorization through
  isolated execution and independently rerunnable bundle export.
- A restart/worker-loss/duplicate-delivery run proves no duplicate case, run,
  or bundle.
- Cancellation, quotas, retention/deletion, revocation, and provider outage
  behave as specified in deployed staging.
- Tenant-isolation and secret-leak audits report zero unauthorized successes or
  disclosed synthetic secrets.
- Backup/restore meets the recorded private-beta RPO/RTO result.
- Measured latency, availability, queue age, and recovery evidence is attached;
  missed targets remain unchecked and block completion.
- Accessibility and responsive visual evidence reflects the real hosted state.
- Full CI and provider gates pass from the exact milestone commit.
- Milestone 8 PRs are merged and issue #13 closes only after this gate.

