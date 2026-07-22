# Deterministic private-beta resilience harness

The RF-8406 gate is one reproducible command:

```bash
npm run test:resilience
```

Its schema-validated registry is
[`resilience-harness.json`](resilience-harness.json). The registry is executable
contract data: every required category appears exactly once, carries a unique
seed and fail-closed invariant, names existing test files, and must be present
in the exact package script.

| Campaign | Production boundary exercised | Required invariant |
|---|---|---|
| load | case service and idempotent reservation | 128 simultaneous starts collapse to one execution/identity; 128 reads agree |
| duplicate delivery | durable Queue consumer and Postgres lease | 250 fixed-seed delivery schedules produce one terminal attempt |
| restart | reconstructed durable service/repositories | 250 fixed-seed retries preserve case/job/bundle/outbox identity |
| dependency outage | composed health and start admission | no memory, no-auth, or host-execution fallback |
| worker loss | Postgres lease recovery and outbox | one recovery transition/intent; bounded exhaustion |
| queue lag | aggregate operations dashboard | warning thresholds fire without scoped identifiers |
| storage failure | private artifact store and durable worker | no terminal success before verified private persistence |
| sandbox failure | sandbox lifecycle and isolated runner | bounded failure with cleanup or quarantine |

The Cucumber journey additionally reconstructs the Postgres repository between
reservation and delivery, submits the same durable message twice, and proves
one worker execution and one terminal job.

## Determinism and interpretation

All clocks, identifiers, provider responses, fault points, and generated
schedules are fixed or explicitly seeded. The gate is safe for CI: it uses only
synthetic fixtures, PGlite, memory-private object adapters, and mocked sandbox
provider handles. It does not require an OpenAI key or user credential.

This is a correctness/load-shape harness, not a hosted performance benchmark.
Its local duration is not availability, p95 latency, Queue capacity, Sandbox
capacity, or cost evidence. RF-8407–RF-8410 must run the corresponding public
and private canaries, dependency failures, and measured load against deployed
staging before private-beta targets can be checked.

## Failure triage

1. Rerun the exact failing file from the registry with its fixed inputs.
2. Preserve the seed, category, stable error code, and aggregate result; do not
   attach payload bodies, credentials, private source, or provider identifiers.
3. Determine whether the invariant failed or the harness itself became stale.
4. Repair the production boundary and retain the regression case. Changing a
   seed or weakening an invariant to obtain green is not a valid fix.
5. Run the full resilience command, BDD, and aggregate verification gate before
   closing the incident.
