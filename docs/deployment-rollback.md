# Deployment and rollback policy

This policy governs ReproForge private-beta deployments. It is executable
through `npm run verify:deployment-policy` and versioned in
[`deployment-policy.json`](deployment-policy.json). It is not evidence that a
live rollback rehearsal has passed; that hosted exercise remains required.

## Compatibility window

ReproForge uses expand/contract database changes. The current application may
start from the immediately previous schema because it applies forward-only
migrations before accepting traffic. The immediately previous application must
continue to read the current schema during the rollback window. The latest
migration may add nullable columns or indexes, but it may not drop/rename data,
change a column type, or require the new application before the previous one can
read existing records.

| Application | Database schema | Supported action |
|---|---|---|
| current | current | normal operation |
| current | previous | migrate forward under the advisory lock, then serve |
| previous | current | application rollback; ignore additive schema |
| previous | previous | normal pre-deployment state |
| any | schema rolled backward | prohibited |

Database rollback means a reviewed forward repair or restore into a separately
verified destination. It never means editing an applied migration, dropping a
forward migration, or destructively reverting the production schema.

## Deployment gate

1. Freeze the exact commit and run `npm run verify` plus the live provider gate.
2. Export and verify the scoped backup; never overwrite an earlier archive.
3. Confirm the policy verifier identifies the expected current and previous
   migrations.
4. Deploy with new repository starts disabled while existing reads remain
   available.
5. Apply migrations under the existing advisory lock.
6. Require dependency readiness and runner capability to report ready.
7. Run `dashboard:snapshot`; resolve every critical alert and record the
   sanitized output.
8. Execute the public canary, then the private canary when that gate is in
   scope.
9. Enable only the reviewed repository classes and execution profiles.
10. After the deployment is ready, inspect bounded Vercel runtime logs for early
    errors. Hobby deployments use the Vercel dashboard/CLI because drains are
    not available; a future paid-plan drain must verify signatures at ingestion.

## Rollback triggers

Rollback the application when a new deployment introduces authorization
success across a tenant boundary, secret disclosure, repeatable data loss,
invalid proof truth, a persistent critical readiness/runner alert, or a failed
canary that did not fail in the previous application. Disable the affected
start path first when reads and cancellation remain safe.

## Rollback procedure

1. Set `REPROFORGE_DISABLE_REPOSITORY_STARTS=true`; use the narrower private or
   profile switch only when evidence proves the incident is isolated.
2. Preserve database, Blob, Queue, audit, and quarantine state. Do not delete or
   replay work broadly.
3. Promote the last verified Vercel deployment while leaving the database at
   its forward schema.
4. Verify liveness, readiness, existing case reads, cancellation, and the
   operations dashboard before admitting new work.
5. Recover expired leases and publish the outbox through bounded operator
   commands; do not manufacture replacement cases.
6. Run the canary and a bounded early-error log scan.
7. Re-enable starts only after the incident owner records the cause, affected
   scope, repair, and evidence.

## Kill-switch semantics

- `REPROFORGE_DISABLE_REPOSITORY_STARTS=true` blocks every new external
  repository start.
- `REPROFORGE_DISABLE_PRIVATE_REPOSITORIES=true` blocks new private repository
  starts while public starts may continue.
- `REPROFORGE_DISABLED_EXECUTION_PROFILES=node22,node24` disables either or both
  schema-closed profiles.

The switches do not hide existing cases, block reads/exports/cancellation, or
change a terminal result. Invalid values fail configuration. Every denied start
uses a stable client error and a sanitized tenant-scoped audit event.
