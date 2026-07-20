# Security model

## Current trust boundary

ReproForge is safe to run only with its bundled demonstration fixture. The
application does not execute arbitrary repositories. `UnavailableExternalRunner`
rejects every external request, and the trusted fixture runner rejects unknown
fixture IDs and actions. The hosted durable adapters have real-provider proof,
but the public synthetic tenant is still unauthenticated; durability is not an
authorization boundary.

The standalone `fixtures/cli-spaces/repro.mjs` command reads only the path supplied to it. It intentionally contains a path-truncation defect for demonstration and must not be reused as production CLI code.

## Controls implemented

- External execution fails closed when no isolated backend exists.
- The MCP surface exposes exactly three schema-closed tools; none accepts a repository URL, command, source payload, ChatGPT credential, or OpenAI API key.
- Every MCP tool is closed-world and non-destructive; start is additive and idempotent, while read/export are read-only.
- The MCP App resource has an empty external connect/resource/frame allowlist and loads no third-party assets.
- `/mcp` uses no auth and wildcard CORS only for the public synthetic fixture. It must not be expanded to customer data or arbitrary execution under that policy.
- Investigator tools are strict data contracts, not shell or filesystem tools.
- The OpenAI client is initialized only for an explicit live request with a configured key.
- Live Responses requests use `store: false`.
- API errors return generic messages and do not echo credentials or raw exceptions.
- Preview/production configuration fails closed unless Neon and private Blob authentication are complete; offline/test builds do not initialize provider clients.
- Every durable case, job, artifact, evidence, quota, outbox, audit, and deletion record is tenant-keyed, and database constraints reject cross-tenant references.
- Serializable idempotency reservation, optimistic versions, compare-and-swap leases, bounded attempts, and terminal-state constraints make duplicate or stale Queue delivery harmless.
- Queue payloads contain only opaque tenant/case/job/event identifiers and a schema/kind; source, commands, tokens, evidence, and object bodies are rejected.
- Artifact bytes are hashed before a private immutable upload, reverified on read, and required before a job can commit success. Direct unauthenticated provider access was denied in the live provider gate.
- Forward-only migrations record canonical SHA-256 checksums, use an advisory lock, roll back failed DDL, and reject applied-file drift.
- Retention/deletion code removes customer-class rows and private objects while preserving only the documented sanitized audit tombstone. Backup/restore verifies manifest and object hashes before accepting restored state.
- Operational logs use allowlisted fields and secret/credential-shape redaction; provider bodies and connection strings are not logged.
- Bundle materialization redacts registered secrets before serialization.
- Canonical hashes cover contract-relevant bundle content and provenance fields.
- Oracle and lock identifiers must agree before bundle validation succeeds.
- CI rejects high-severity dependency audit findings and runs the full verification gate.

## Not yet safe or supported

- Cloning or executing a user-supplied repository.
- Attaching to a production environment.
- Supplying production credentials, customer datasets, or private source code.
- Multi-user or customer-data operation without OAuth principal/tenant resolution, repository authorization, abuse controls, and a deployment review.
- Treating the anonymous trusted-sample caller scope as tenant isolation.
- Treating a development tunnel, developer-mode app, or local plugin wrapper as a production security boundary.
- Treating redaction as a substitute for excluding secrets at input time.
- Treating the provider-tested development resources as a production service, availability promise, or authorization proof.

## Hosted provider boundary

Neon Postgres is the system of record. Private Vercel Blob stores only
content-addressed artifact bytes. Vercel Queue carries identifier-only delivery
hints; it cannot authorize work or override Postgres state. Vercel credentials
remain server-side in ignored local files or scoped project environment
variables and are never tool inputs. Live provider tests use unique synthetic
tenants/objects, remove active test data, and verify that temporary restore
schemas are gone. See the [operations runbook](operations.md) for the exact
fail-closed setup and recovery gates.

## Requirements for a future external runner

An external adapter must execute in a disposable sandbox as a non-root identity, drop Linux capabilities, impose CPU, memory, disk, process, and time limits, default-deny network after an approved acquisition phase, receive no ambient host secrets, and have no host checkout or container-socket mount. The application must verify runner health and provenance and continue to fail closed on any ambiguity.

## Dependency and model risk

Dependencies are pinned by `package-lock.json` and audited in CI. A clean audit does not prove the absence of vulnerabilities. GPT output is untrusted structured input: schemas, permission checks, and deterministic verification remain mandatory even when the model response appears plausible.

For reporting instructions, see the repository [security policy](../SECURITY.md).
