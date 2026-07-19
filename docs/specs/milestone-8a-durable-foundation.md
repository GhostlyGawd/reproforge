# Milestone 8A specification: durable foundation

- **Status:** ready for implementation
- **Parent:** [Milestone 8 issue #13](https://github.com/GhostlyGawd/reproforge/issues/13)
- **Depends on:** Milestone 7
- **Unblocks:** identity, repository authorization, and isolated execution

## Outcome

Replace process-local case/job state with a transactional, tenant-keyed system
of record and private content-addressed artifacts. Job delivery must be safe
under duplicates, crashes, deploys, and expired leases. This milestone does not
execute external repositories and does not expose customer data.

## Functional contract

### Data model

All identifiers are opaque and all tenant-owned tables include `tenant_id` in
their primary or unique access path.

| Table | Required purpose and constraints |
|---|---|
| `tenants` | stable tenant identity, lifecycle state, created/deleted timestamps |
| `principals` | external subject mapping scoped to one tenant; no access token storage |
| `cases` | source descriptor, domain state, schema version, optimistic version, timestamps |
| `jobs` | case link, operational state, phase, attempt count, lease owner/expiry, cancellation, sanitized failure |
| `idempotency_keys` | unique `(tenant_id, caller_id, key)`, canonical command hash, case/job result |
| `run_evidence` | immutable, ordered sanitized run records and environment provenance |
| `artifacts` | tenant/case key, kind, content hash, byte count, private object key, retention class |
| `outbox_events` | transactional queue intents, delivery count, next attempt, delivered timestamp |
| `audit_events` | append-only actor/action/object/outcome metadata with no source or secret body |
| `quota_ledger` | tenant/resource/window usage and reservation state |
| `deletion_requests` | requested/scheduled/completed state and per-class deletion result |

Migrations are forward-only, checksum-recorded, and safe to rerun. Database
constraints reject cross-tenant references, invalid state values, duplicate
idempotency reservations, negative quotas, and non-monotonic versions.

### Transaction and lease rules

- Starting work atomically reserves idempotency, creates one case and one job,
  reserves quota, appends an audit event, and creates an outbox event.
- Same tenant/caller/key/canonical input returns the original identifiers.
- Same tenant/caller/key with different canonical input returns
  `IDEMPOTENCY_CONFLICT` without mutation.
- A worker claims a queued or expired-retryable job with compare-and-swap,
  assigns a unique lease owner, and increments the attempt exactly once.
- Only the lease owner may append attempt evidence or transition the job.
- Terminal jobs never return to active states.
- A job cannot become `SUCCEEDED` until required artifacts are durably written
  and their hashes are committed.
- Queue delivery is a hint; Postgres is authoritative. Duplicate or stale
  deliveries are harmless.
- Recovery requeues expired leases within a configured maximum; exhaustion
  yields a sanitized terminal operational failure, never `VERIFIED`.

### Artifact rules

- Artifact bytes are hashed before upload and addressed by tenant, case, kind,
  and digest.
- Objects use private access and are read only through an authorized service
  method.
- A repeated identical write returns the existing object identity.
- A hash or byte-count mismatch aborts the transaction and removes any partial
  object when possible.
- Bundles remain independently runnable and contain no provider dependency.
- Source and run artifacts have configured retention; audit/billing retention
  is separate and documented.

### Runtime configuration

Production adapters are selected only when a complete validated configuration
is present. Offline tests and `next build` must not require credentials or make
network calls. Partial production configuration fails readiness with stable
codes rather than silently falling back to memory.

## Ordered task list

- [x] `RF-8101` Add failing configuration-contract tests and a strict runtime configuration schema that distinguishes offline, test, preview, and production modes.
- [x] `RF-8102` Define provider-neutral `UnitOfWork`, durable repository, artifact, queue, quota, audit, and lease contracts without importing provider SDKs into domain/application modules.
- [x] `RF-8103` Write the initial Postgres migration set and migration ledger for every table, index, unique constraint, foreign key, retention field, and optimistic version above.
- [x] `RF-8104` Implement the Postgres repositories and transactional idempotent start with tenant-keyed reads and compare-and-swap updates.
- [x] `RF-8105` Implement private content-addressed artifact storage, verified round-trips, and deletion semantics.
- [x] `RF-8106` Implement the transactional outbox, queue publisher/consumer adapter, lease claim/renew/release, bounded retry, and expired-lease recovery sweep.
- [x] `RF-8107` Implement durable quota reservations, cancellation flags, retention scheduling, deletion requests, and append-only audit events.
- [x] `RF-8108` Add liveness, readiness, database, artifact, queue, and runner-capability health contracts with sanitized structured logs and metrics.
- [ ] `RF-8109` Add backup/export and restore verification for one tenant's complete case/job/evidence/artifact manifest without exposing object bodies in logs.
- [ ] `RF-8110` Route the trusted fixture through the durable adapters in provider integration tests while preserving its existing browser, REST, MCP, and bundle identity behavior.
- [ ] `RF-8111` Update operational, security, privacy, architecture, limitation, and setup documentation; attach the milestone evidence manifest.

## TDD and property requirements

The first commit for behavior begins with failing tests for configuration,
unique idempotency, transaction rollback, and lease ownership.

Properties run at least 250 generated sequences unless a higher existing count
applies:

- arbitrary duplicate/concurrent starts create one case and job;
- conflicting idempotency input never mutates the original record;
- arbitrary authorized tenant operations never read or modify another tenant;
- any job transition sequence preserves terminality and lease ownership;
- duplicate/out-of-order queue deliveries preserve a single attempt result;
- serialization and database round-trips preserve every schema-valid snapshot;
- artifact write/read/delete round-trips preserve bytes and canonical digest;
- redaction removes registered secret values and credential-shaped strings;
- quota reservations never go negative or exceed the configured hard limit;
- retention/deletion sequences remove customer data while preserving only the
  explicitly documented audit tombstone.

Postgres integration tests exercise real unique constraints, isolation, and
transactions. An in-memory double cannot close `RF-8103`, `RF-8104`, or
`RF-8106`.

## Executable BDD

```gherkin
Feature: Durable reproduction state
  Scenario: A trusted reproduction survives an application restart
  Scenario: An idempotent retry after a restart returns the original case
  Scenario: Conflicting use of an idempotency key is rejected
  Scenario: A duplicate queue delivery performs no duplicate work
  Scenario: An expired worker lease is recovered once
  Scenario: A tenant cannot read another tenant's case
  Scenario: A cancelled queued job never starts
  Scenario: A verified bundle is readable after restore
  Scenario: Retention deletion removes customer artifacts and records an audit tombstone
  Scenario: Missing production configuration fails readiness without falling back
```

Step definitions use application ports and provider test instances, not browser
selectors.

## Acceptance and evidence gate

- All `RF-8101`–`RF-8111` tasks have direct passing evidence.
- Migrations apply from empty, reapply safely, and upgrade a seeded previous
  schema fixture.
- A kill/restart test proves the same job resumes without duplicate evidence or
  bundle identity.
- A real Postgres provider test proves cross-tenant reads return not found and
  concurrent idempotent starts create one record.
- A private artifact provider test proves unauthorized direct read is denied,
  authorized round-trip succeeds, and deletion removes access.
- A queue provider test proves duplicate delivery and expired-lease recovery.
- Backup/restore recreates a complete sanitized manifest and verifies hashes.
- `npm run verify`, integration, property, BDD, migration, security, and
  evidence-verifier commands pass locally or in the authorized CI environment.
- Documentation and the completion audit distinguish local contract proof from
  real provider proof.
- The milestone PR is green and merged before 8B begins.

