# Hosted operations and recovery runbook

This runbook covers the implemented durable foundation, isolated repository
execution, recovery controls, and account data lifecycle. It is not a
production-launch guide: live account authorization, deployed journey drills,
domain configuration, alerts, and a public ChatGPT app remain gated milestones.

## Runtime modes

| Mode | State | Credentials | Intended use |
|---|---|---|---|
| `offline` | process-local memory | none | local trusted demo and build |
| `test` | process-local test adapters | none | deterministic CI |
| `preview` | Neon + private Blob + Vercel Queue | server-owned | hosted preproduction |
| `production` | Neon + private Blob + Vercel Queue | server-owned | future production |

`VERCEL_ENV` derives hosted mode on Vercel unless
`REPROFORGE_RUNTIME_MODE` is explicit. Preview/production requires an HTTPS
`REPROFORGE_BASE_URL`, `DATABASE_URL`, and either the Vercel Blob OIDC pair
(`BLOB_STORE_ID` plus `VERCEL_OIDC_TOKEN`) or the local/off-platform
`BLOB_READ_WRITE_TOKEN`. Partial or unknown `REPROFORGE_*` configuration fails
readiness. It never falls back to memory.

End users never provide an OpenAI API key, provider credential, database URL,
or Queue token. The optional standalone Responses adapter is a separate route
and is not part of the subscription-first ChatGPT/MCP path.

## Nonproduction provider setup

Use a dedicated Vercel project and free/development resources. Do not paste
credentials into source, issues, logs, screenshots, or evidence manifests.

1. Link the repository to the intended Vercel project.
2. Connect a private Vercel Blob store and ensure the development project can
   create Vercel Sandbox sessions through its OIDC identity.
3. Install Neon through Vercel Marketplace, choose the intended region, keep
   built-in application auth disabled for this milestone, and connect it to the
   project.
4. Pull development credentials into the ignored file:

   ```bash
   vercel env pull .env.local --yes
   ```

5. Confirm only the presence—not the values—of `DATABASE_URL`,
   `DATABASE_URL_UNPOOLED`, `BLOB_READ_WRITE_TOKEN` or the OIDC pair, and
   `VERCEL_OIDC_TOKEN`.

The canonical defaults are a 90-second job lease, 30-second outbox claim, five
delivery attempts, 25-event publish batch, two active jobs per tenant,
24-hour Queue retention, and 30-day customer-data retention. Override only
through the validated variables documented in [`.env.example`](../.env.example).

The current Hobby preview configures the Queue callback to the plan-compatible
60-second Function maximum. The 15-minute sandbox attempt budget is an internal
upper bound, not a promise that one hosted callback can wait that long. Before
8D can claim a stable repository journey, its effective profile must complete
inside the deployed callback limit or move orchestration behind a provider-
verified durable workflow/worker boundary.

## Migration and provider gate

Hosted composition initializes lazily. Its first operation applies the nine
forward-only migrations under a Postgres advisory lock and records canonical
SHA-256 checksums in `reproforge_schema_migrations`. Reapplying is safe; an
applied checksum mismatch is a hard failure. Never edit an applied migration—
add a successor.

After pulling a dedicated nonproduction environment, run:

```bash
npm run test:providers
```

The command deliberately enables the live gate itself; it cannot pass by
silently skipping. It proves:

- private Blob denies direct unauthenticated access, round-trips authorized
  bytes, and removes them on deletion;
- Vercel Queue accepts only the six-field opaque reproduction identity;
- the complete trusted fixture survives adapter reconstruction with one case,
  job, attempt, execution, Queue identity, and bundle identity;
- live Postgres serialization collapses concurrent starts and recovers one
  expired lease once;
- database, artifact, and Queue readiness are healthy and the bounded hosted
  runner probe creates, executes in, and cleans an isolated deny-all sandbox;
- a complete tenant archive is exported, its source object removed, restored
  into a fresh Neon schema, re-hashed, and independently read from private
  Blob.
- a bounded public GitHub archive crosses from the trusted host into an
  always-deny-all sandbox as bytes only, retains its SHA-256, exposes no
  acquisition credential, enforces output/cancellation policy, and cleans the
  sandbox;
- fresh microVMs restored from one prepared snapshot do not share mutations and
  every sandbox/snapshot is cleaned; and
- the exact public canary revision runs one control plus three candidates in
  four fresh microVMs and emits a clean independently validatable `VERIFIED`
  bundle without minting a GitHub credential.

Provider tests use generated synthetic tenants and schemas. They remove active
test cases, artifacts, objects, and temporary schemas. The documented sanitized
postcondition is nine applied migrations with zero active test tenants, zero
test cases/artifacts, and zero temporary restore schemas.

## Health and fail-closed behavior

| Route | Meaning | Expected current result |
|---|---|---|
| `/health/live` | process can answer | `200` / `PROCESS_ALIVE` |
| `/health/ready` | configuration, database, artifact store, and Queue boundary | `200` only when every check is ready |
| `/health/runner` | composed isolated repository execution | `200` / `RUNNER_READY` only after a real bounded deny-all sandbox probe succeeds; otherwise `503` with a stable unavailable code |

Do not route customer traffic when readiness is unavailable. Do not replace a
failed hosted dependency with local memory. Health output contains stable codes
and timings only; raw provider errors and credentials stay in server-side
diagnostics after redaction. Hosted configuration failures identify only the
failed boundary: `INVALID_RUNTIME_CONFIGURATION`,
`INVALID_WEB_AUTHENTICATION_CONFIGURATION`, `INVALID_OAUTH_CONFIGURATION`,
`INVALID_GITHUB_CONFIGURATION`, or `HOSTED_ORIGIN_MISMATCH`. They never include
the rejected value or credential.

## Recovery and data lifecycle

- Postgres—not Queue—is authoritative. Duplicate/stale delivery is ignored
  through durable identity, terminal-state, and lease checks.
- An expired lease is requeued once per compare-and-swap recovery decision.
  Attempt exhaustion records a sanitized failure and never fabricates
  `VERIFIED`.
- `BUDGET_EXHAUSTED`, `CANCELLED`, and `UNSUPPORTED_SOURCE` are terminal and
  non-retryable. A provider interruption or execution failure may consume only
  the bounded retry policy.
- A bundle must be private and hash-verified before success commits.
- Customer-class records and artifacts default to 30 days. Principal, audit,
  quota, and deletion records default to 365 days.
- Retention deletion removes private objects before purging database state and
  retains only the explicitly sanitized audit tombstone.
- Backup export requires one active, quiescent tenant. Restore verifies the
  manifest and every object before mutation, records a restore session, then
  re-exports and digest-compares the result.

Signed-in users can open `/account`, download a portable tenant archive through
`GET /api/account/export`, or schedule deletion through
`POST /api/account/delete`. Both routes require the server-owned web session and
an idempotency key. Deletion additionally requires a same-origin request and the
exact visible confirmation phrase. A deletion request immediately suspends the
tenant and requests cancellation of queued/running work; the database purge
waits until no run remains active and a private-object delete failure leaves the
request retryable.

## Production-only operator commands

`npm run ops -- ...` refuses offline/test mode, applies migrations, returns
structured JSON, and maps unexpected failures to one sanitized error. Run it
only from an authenticated operator environment with the intended hosted
configuration loaded.

```bash
npm run ops -- leases:recover --limit 100
npm run ops -- outbox:publish
npm run ops -- dashboard:snapshot
npm run ops -- alerts:check
npm run ops -- retention:schedule --limit 100
npm run ops -- retention:execute
npm run ops -- backup:export --tenant-id tenant_example --output tenant-example.json
npm run ops -- backup:verify --input tenant-example.json
npm run ops -- backup:restore --input tenant-example.json --actor-id operator_example
npm run ops -- quarantine:list --limit 25
npm run ops -- quarantine:resolve --tenant-id tenant_example --attempt-id job_example.attempt-1 --resource-type sandbox --provider-resource-id sandbox_example --actor-id operator_example
```

Archive export creates a new file and refuses to overwrite an existing path.
Verification is read-only. Restore is mutating and fails closed on a conflicting
tenant identity. Quarantine resolution matches the exact tenant, attempt,
resource type, and provider identifier, deletes that provider resource first,
then records a sanitized resolution audit; a deletion failure remains open.
Retention execution claims at most one due deletion request per invocation.

The recovery sweep, deletion executor, quarantine cleanup, and backup/restore
commands remain operator primitives rather than public administration
endpoints. A scheduled control plane, alerts, dashboards, and a separately
authenticated operator surface remain private-beta tasks; until then these
commands must not be represented as automated production operations.

## Private operations dashboard and alerts

`dashboard:snapshot` emits one schema-closed, global aggregate with readiness,
runner capability, kill-switch state, job counts/age, expired leases, outbox
count/lag, deletion failures, and open quarantines. It contains no tenant,
principal, repository, case, job, provider-resource, source, or object identity.
`alerts:check` returns only firing alerts. Every alert is owned by
`platform-on-call`, carries its threshold and test procedure, and links back to
this runbook.

Health checks also emit allowlisted structured JSON to Vercel runtime logs.
Because the current project uses the Hobby plan, the primary hosted view is the
Vercel deployment Logs tab or a bounded `vercel logs <deployment-url> --level
error --since 1h` query; no log drain is claimed. A future paid-plan drain must
verify Vercel's signature over the raw body before accepting telemetry.

### Alert: dependency readiness unavailable

Fires whenever canonical configuration, Postgres, private Blob, or Queue
readiness is unavailable. Keep traffic closed, inspect the stable component
code and structured runtime log, restore the dependency, then rerun
`npm run test:operations` and readiness. Never fall back to memory.

### Alert: runner unavailable

Fires whenever the real deny-all sandbox probe is unavailable. Disable new
repository starts, preserve reads/cancellation, inspect provider health and
cleanup state, then run `tests/runtime-runner-health.test.ts` and the live
runner probe before re-enabling starts.

### Alert: queued job age high

Fires at 240 seconds so operators can act before the five-minute private-beta
queue-age ceiling. Check outbox publication, Queue delivery, worker capacity,
and kill-switch state; do not create a duplicate case.

### Alert: outbox lag high

Fires when the oldest pending/sending durable outbox intent reaches 120
seconds. Run the bounded outbox publisher, inspect only stable failure codes,
and verify one delivery identity before clearing the alert.

### Alert: expired leases present

Fires when any running job has an expired lease. Run bounded lease recovery and
outbox publication, then prove the compare-and-swap result did not duplicate a
run or bundle.

### Alert: outbox dead present

Fires when any outbox event exhausts delivery. Keep its job non-successful,
inspect the sanitized failure code, repair the dependency or forward state, and
use a reviewed recovery action rather than editing the event.

### Alert: deletion failure present

Fires when provider-first account deletion fails. Preserve the suspended
tenant and retryable request, restore Blob deletion capability, and rerun the
single deletion executor. Never purge database rows ahead of private objects.

### Alert: sandbox quarantine present

Fires for every unresolved sandbox or snapshot cleanup failure. List open
resources, match the exact tenant/attempt/type/provider identity, run the exact
quarantine resolution, and require provider deletion before the resolution
audit appears.

## Feature kill switches and rollback

The three environment switches documented in [`.env.example`](../.env.example)
disable all new repository starts, only private-repository starts, or selected
`node22`/`node24` profiles. They never hide existing cases or block reads,
exports, or cancellation. Values are schema-closed; invalid configuration fails
startup. Apply them through a reviewed deployment so the exact configuration
change is attributable.

The executable compatibility window, deployment gate, rollback triggers, and
application-only rollback procedure are in the
[deployment and rollback policy](deployment-rollback.md). Database schemas move
forward only; rollback promotes the last verified application while retaining
the current additive schema.

## Incident rules

1. Preserve Postgres and private objects; never clear a broad provider resource
   to repair one job.
2. Use tenant/case/job/event identifiers only in tickets and logs—never object
   bodies, connection strings, tokens, commands, or private source.
3. If Queue delivery is uncertain, inspect durable outbox/job/lease state and
   run the bounded recovery path. Do not manufacture a new case.
4. If an artifact is missing or hash-mismatched, keep the job non-successful and
   restore from a verified archive or rerun the synthetic work.
5. Roll application code backward only when it remains compatible with every
   applied forward migration. Database rollback means a tested forward repair
   or verified restore, not migration-file mutation.
6. Re-run `npm run test:providers`, `npm run verify`, and the exact CI commit
   before declaring recovery complete.
7. If sandbox stop or snapshot deletion fails, keep the attempt quarantined,
   record only the sanitized resource identity through the approved sink, and
   do not change an already computed proof outcome.

## Evidence and current boundary

The durable-provider record is in
[`docs/evidence/milestone-8a`](evidence/milestone-8a/README.md), and the isolated
runner/public-canary record is in
[`docs/evidence/milestone-8c`](evidence/milestone-8c/README.md). Backend provider
work has no meaningful screenshot state, so its evidence is test output,
source/bundle hashes, network-denial behavior, migration catalog state,
private-access behavior, and cleanup postconditions. Visual evidence becomes
mandatory again for the hosted browser/ChatGPT journey.
