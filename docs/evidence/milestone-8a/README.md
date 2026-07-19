# Milestone 8A incremental evidence

This directory records task-level proof while the durable-foundation milestone
is in progress. The final manifest and provider evidence are attached by
`RF-8111`; an unchecked provider gate is never inferred from local proof.

| Task | Verified behavior | Direct command/evidence |
|---|---|---|
| `RF-8101` | hosted configuration fails closed, local modes stay credential-free, secrets are omitted from summaries | `tests/runtime-config.test.ts`, `tests/runtime-config.property.test.ts` (600 generated cases), credential-free production build |
| `RF-8102` | production ports are provider-neutral; queue payloads, artifact identities, leases, audit metadata, and quota reservations validate strictly | `tests/production-ports.test.ts`, `tests/production-ports.property.test.ts` (1,200 generated cases) |
| `RF-8103` | two forward migrations apply from empty, preserve a seeded prior version, record checksums, rerun safely, roll back atomically, and enforce tenant/state/idempotency/quota/version/append-only constraints | `npm run test:migrations` (9 tests, including 250 generated invalid versions), followed by `npm run check` (96 Vitest tests, 13 BDD scenarios/73 steps, production build) |
| `RF-8104` | serializable Postgres transactions create case/job/idempotency/quota/audit/outbox state atomically; exact retries reuse, conflicts and quota failures roll back, tenant reads are isolated, and stale writes fail CAS | `npm run test:persistence` (12 tests, including 250 generated duplicate sequences), four durable-state BDD scenarios, `npm audit` (zero vulnerabilities), followed by `npm run check` (108 Vitest tests, 17 BDD scenarios/113 steps, production build) |

## RF-8103 proof boundary

PGlite runs real PostgreSQL in WebAssembly and closes the local SQL semantics
gate for schema and migration behavior. It does not claim a live Neon provider
round-trip. The real provider transaction/isolation evidence remains required
by `RF-8110` and the Milestone 8A acceptance gate.

The Neon adapter uses the current interactive-transaction `Pool` path, has
commit/rollback/release contract tests, and is created lazily so a
credential-free build performs no connection. These local adapter contracts do
not replace the live Neon concurrency/isolation gate.

No visual artifact applies to this schema-only task; its observable result is
the migration ledger, database catalog, constraint behavior, and command log.
