# Security model

## Current trust boundary

The bundled demonstration fixture is the only generally available user-facing
path. Repository execution is implemented only for an authorized immutable
GitHub source and a narrow Node/npm profile, and always runs in disposable
Vercel Sandbox microVMs. A public synthetic canary has direct provider proof;
live private-repository/account authorization and the stable hosted composition
have not yet passed their separate gates. Arbitrary URLs, branches, commands,
local repositories, and unsupported profiles remain rejected.

The no-auth trusted sample is an anonymous synthetic scope. Durability is not
authorization: protected repository operations require OAuth scopes, a mapped
principal/tenant, and a currently authorized GitHub App installation before
they can reach the runner.

The standalone `fixtures/cli-spaces/repro.mjs` command reads only the path supplied to it. It intentionally contains a path-truncation defect for demonstration and must not be reused as production CLI code.

## Controls implemented

- Repository execution fails closed when authorization, immutable source,
  supported profile, durable provider, or isolated runner configuration is
  missing.
- The MCP surface exposes exactly five schema-closed tools: start,
  authorized-repository list, read, cancel, and export. None accepts a
  repository URL, shell command, source body, ChatGPT credential, provider
  token, or OpenAI API key.
- The trusted sample declares `noauth`; repository list/cancel require OAuth,
  and repository start/read/export enforce their declared no-auth/OAuth
  alternatives and least-privilege scopes.
- OAuth access tokens are issuer/audience/signature/expiry/scope checked, then
  mapped to an active server-owned principal and tenant. Caller-supplied IDs are
  never accepted as identity.
- GitHub App state and callback inputs are signed, single-use, time-bounded, and
  installation/repository scoped. Webhook ordering and revocation are durable.
- The MCP App resource has an empty external connect/resource/frame allowlist and loads no third-party assets.
- `/mcp` uses no auth and wildcard CORS only for the public synthetic fixture. It must not be expanded to customer data or arbitrary execution under that policy.
- Investigator tools are strict data contracts, not shell or filesystem tools.
- The OpenAI client is initialized only for an explicit live request with a configured key.
- Live Responses requests use `store: false`.
- API errors return generic messages and do not echo credentials or raw exceptions.
- Preview/production configuration fails closed unless the canonical origin,
  web/OAuth identity, GitHub App, Neon, private Blob, Queue, and isolated-runner
  configuration are complete; offline/test builds do not initialize provider
  clients.
- Every durable case, job, artifact, evidence, quota, outbox, audit, and deletion record is tenant-keyed, and database constraints reject cross-tenant references.
- Serializable idempotency reservation, optimistic versions, compare-and-swap leases, bounded attempts, and terminal-state constraints make duplicate or stale Queue delivery harmless.
- Queue payloads contain only opaque tenant/case/job/event identifiers and a schema/kind; source, commands, tokens, evidence, and object bodies are rejected.
- Artifact bytes are hashed before a private immutable upload, reverified on read, and required before a job can commit success. Direct unauthenticated provider access was denied in the live provider gate.
- Forward-only migrations record canonical SHA-256 checksums, use an advisory lock, roll back failed DDL, and reject applied-file drift.
- Account export requires a server-owned tenant session, an idempotency key, a
  daily quota, and a quiescent tenant; responses are integrity-tagged and never
  cached. Account deletion additionally requires same-origin submission and an
  exact destructive confirmation phrase.
- Retention/deletion suspends new starts, requests cancellation, removes private
  objects before customer-class rows, and preserves only the documented
  sanitized audit tombstone. Backup/restore verifies the portable manifest and
  every object hash before accepting restored state.
- Operational logs use allowlisted fields and secret/credential-shape redaction; provider bodies and connection strings are not logged.
- Bundle materialization redacts registered secrets before serialization.
- Canonical hashes cover contract-relevant bundle content and provenance fields.
- Oracle and lock identifiers must agree before bundle validation succeeds.
- Public source acquisition mints no credential. Private acquisition uses a
  short-lived installation credential only on the exact GitHub API request;
  authorization is not forwarded to the temporary archive host.
- The trusted host streams at most 100 MiB of compressed archive bytes. Archive
  traversal, absolute paths, links/special files, excessive entries, and
  extracted-workspace overflow are rejected before repository commands.
- Supported npm locks are parsed as data. Dependency preparation disables
  lifecycle scripts; repository-controlled execution starts only after network
  policy is deny-all and never reopens it.
- Every control/candidate run restores a fresh immutable snapshot, receives no
  ambient credential or host mount, and is bounded by command/attempt time,
  workspace, output, run, and tool budgets. Cancellation stops active work;
  cleanup is unconditional and failures enter quarantine.
- `VERIFIED` still requires the deterministic oracle, a negative control, and
  all clean candidates. Provider or model output cannot construct proof truth.
- CI rejects high-severity dependency audit findings and runs the full verification gate.

## Not yet safe or supported

- Executing an arbitrary repository URL, branch head, local checkout, shell
  command, ecosystem, or lockfile.
- Treating the development public-canary proof as authorization for general
  public repositories.
- Private-repository/customer use before live Auth0, GitHub installation,
  revocation, and composed hosted end-to-end evidence passes.
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

## Isolated runner boundary

The provider-tested adapter executes in disposable Vercel Sandbox microVMs,
with explicit CPU/memory/time configuration, bounded filesystem/output policy,
deny-all repository execution, no ambient host secrets, and no host checkout or
container-socket mount. Source acquisition and dependency preparation are
trusted-supervisor phases; repository-controlled code cannot run while GitHub
or registry access is available. The hosted runner health route now performs a
real bounded deny-all sandbox create/execute/cleanup probe and admits new starts
only while it reports ready. This local implementation does not replace the
pending authenticated deployed-journey and degradation drills.

## Dependency and model risk

Dependencies are pinned by `package-lock.json` and audited in CI. A clean audit does not prove the absence of vulnerabilities. GPT output is untrusted structured input: schemas, permission checks, and deterministic verification remain mandatory even when the model response appears plausible.

For reporting instructions, see the repository [security policy](../SECURITY.md).
