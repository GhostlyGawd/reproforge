# Hosted operations and recovery runbook

This runbook covers the implemented durable trusted-fixture foundation. It is
not a production-launch guide: OAuth, external repository execution, a hosted
consumer/runner, domain configuration, alerts, and a public ChatGPT app remain
later gated milestones.

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
2. Connect a private Vercel Blob store.
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
seven-day Queue retention, and 30-day customer-data retention. Override only
through the validated variables documented in [`.env.example`](../.env.example).

## Migration and provider gate

Hosted composition initializes lazily. Its first operation applies the six
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
- database, artifact, and Queue readiness are healthy while the unsupported
  external runner remains explicitly unavailable; and
- a complete tenant archive is exported, its source object removed, restored
  into a fresh Neon schema, re-hashed, and independently read from private
  Blob.

Provider tests use generated synthetic tenants and schemas. They remove active
test cases, artifacts, objects, and temporary schemas. The documented sanitized
postcondition is six applied migrations with zero active test tenants, zero
test cases/artifacts, and zero temporary restore schemas.

## Health and fail-closed behavior

| Route | Meaning | Expected durable-foundation result |
|---|---|---|
| `/health/live` | process can answer | `200` / `PROCESS_ALIVE` |
| `/health/ready` | configuration, database, artifact store, and Queue boundary | `200` only when every check is ready |
| `/health/runner` | external isolated repository execution | `503` / `RUNNER_NOT_CONFIGURED` until Milestone 8C |

Do not route customer traffic when readiness is unavailable. Do not replace a
failed hosted dependency with local memory. Health output contains stable codes
and timings only; raw provider errors and credentials stay in server-side
diagnostics after redaction.

## Recovery and data lifecycle

- Postgres—not Queue—is authoritative. Duplicate/stale delivery is ignored
  through durable identity, terminal-state, and lease checks.
- An expired lease is requeued once per compare-and-swap recovery decision.
  Attempt exhaustion records a sanitized failure and never fabricates
  `VERIFIED`.
- A bundle must be private and hash-verified before success commits.
- Customer-class records and artifacts default to 30 days. Principal, audit,
  quota, and deletion records default to 365 days.
- Retention deletion removes private objects before purging database state and
  retains only the explicitly sanitized audit tombstone.
- Backup export requires one active, quiescent tenant. Restore verifies the
  manifest and every object before mutation, records a restore session, then
  re-exports and digest-compares the result.

The current recovery sweep, deletion executor, and backup/restore services are
application/operator primitives, not public administration endpoints. A
scheduled control plane, alerts, dashboards, and operator authentication remain
private-beta tasks; until then they must not be represented as automated
production operations.

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

## Evidence and current boundary

The sanitized provider and regression record is in
[`docs/evidence/milestone-8a`](evidence/milestone-8a/README.md). Backend provider
work has no meaningful visual state, so its evidence is test output, migration
catalog state, private-access behavior, and cleanup postconditions. Visual
evidence becomes mandatory again when a hosted browser/ChatGPT journey exists.
