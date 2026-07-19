# ADR 0002: managed production stack with replaceable boundaries

- **Status:** accepted implementation baseline
- **Date:** 2026-07-19
- **Scope:** ReproForge private beta and hosted plugin readiness
- **Supersedes:** no prior provider decision

## Context

Milestone 7 proves the keyless ChatGPT/MCP journey only for a bundled fixture
and process-local state. The complete product needs durable multi-tenant state,
OAuth compatible with ChatGPT's MCP client, least-privilege GitHub access,
private artifacts, at-least-once job delivery, and an execution boundary that
never runs an untrusted repository on the application host.

The current application is a strict Next.js 16 TypeScript repository and the
owner has authenticated Vercel access. No production project, provider
credentials, domain, or paid resources are currently configured.

## Decision

Use a managed, Vercel-centered baseline while preserving provider-neutral
application interfaces:

- deploy the Next.js web, REST, MCP, health, and OAuth resource-metadata routes
  on Vercel;
- use Auth0 as the OAuth 2.1 authorization server because the Apps SDK guidance
  documents established-provider integration and MCP client registration;
- use a dedicated GitHub App for repository installation and authorization,
  separate from end-user login;
- use Neon Postgres for transactional case/job/idempotency/lease/outbox/audit
  state;
- use private Vercel Blob for source, run, and bundle artifacts;
- use Vercel Queues for at-least-once delivery while treating Postgres as the
  source of truth and recovering expired work independently of queue retention;
- use Vercel Sandbox for disposable external-repository execution; and
- keep the OpenAI Responses adapter optional and service-owned.

The production code depends on `ReproductionRepository`, `UnitOfWork`,
`ArtifactStore`, `JobQueue`, `AccessTokenVerifier`, `SourceAuthorization`,
`SourceAcquirer`, `IsolatedRunner`, `QuotaPolicy`, `AuditSink`, and `Clock`
interfaces. Provider modules implement those interfaces and are selected by
validated environment configuration.

## Reasons

- The stack matches the existing Next.js runtime and minimizes bespoke control
  plane code.
- Auth0 is an established authorization server; ReproForge must not implement
  OAuth token issuance itself.
- Postgres transactions and unique constraints provide the authoritative
  idempotency and lease semantics that an at-least-once queue alone cannot.
- Queue payloads can contain identifiers only, keeping source and credentials
  out of event infrastructure.
- A separate disposable microVM is consistent with ReproForge's fail-closed
  runner invariant.
- Provider-neutral ports keep local tests deterministic and permit a later
  migration if a beta provider capability becomes unsuitable.

## Rejected alternatives

### ChatGPT-only execution

Rejected because a ChatGPT subscription does not provide ReproForge with
durable tenant storage, GitHub installation credentials, arbitrary repository
execution, retention controls, or portable artifact hosting.

### User-supplied OpenAI API keys

Rejected for the primary product because they add billing and secret burden
without solving repository execution or persistence. The existing standalone
Responses adapter remains optional.

### Custom OAuth server

Rejected because token issuance, client registration, PKCE, rotation,
revocation, and discovery are security-sensitive commodity capabilities.

### Host or Vercel Function subprocess execution

Rejected because untrusted source must never execute in the web process or on
the developer host.

### Queue as the system of record

Rejected because delivery is at least once and retained messages are not a
substitute for transactional job state, leases, audit records, or backups.

### Workflow DevKit as the only job ledger

Not selected as the baseline because its orchestration can complement but not
replace the product's portable, queryable case/job/audit contract. Direct queue
delivery plus Postgres leases is easier to test independently. WDK may be
adopted later behind `JobQueue` after provider-backed validation.

### Supabase as combined auth/database/storage

Not selected because the current OpenAI authentication guidance explicitly
documents established MCP authorization providers such as Auth0, while
ReproForge benefits from keeping user OAuth, GitHub installation authorization,
database, and artifacts as distinct trust domains.

## Security consequences

- Access tokens are verified on every protected request for signature, issuer,
  audience/resource, time validity, and scope.
- GitHub installation tokens are minted just in time, never stored, never sent
  to ChatGPT or widget output, and never available during untrusted execution.
- All durable rows and artifact keys include a tenant boundary.
- Source and bundle objects are private; download is mediated by authorized
  application routes.
- Queue messages contain tenant-safe opaque identifiers, not source, tokens,
  commands, or artifact bodies.
- Sandboxes receive no application, database, Auth0, GitHub, OpenAI, Vercel, or
  cloud credentials. Acquisition and execution network phases are distinct.
- Provider unavailability maps to truthful retryable or blocked outcomes and
  can never synthesize `VERIFIED`.

## Operational consequences

- Provisioning creates recurring provider costs owned by ReproForge.
- Provider beta risk for Queues is recorded and covered by a Postgres outbox,
  recovery sweep, contract tests, metrics, and a replaceable interface.
- Backups and restore drills cover Postgres and artifact manifests; ephemeral
  sandboxes are never a source of truth.
- Deployment configuration must validate all required environment variables at
  runtime without breaking an offline `next build`.

## Source basis

- [OpenAI Apps SDK authentication](https://developers.openai.com/apps-sdk/build/auth)
- [OpenAI plugin submission](https://learn.chatgpt.com/docs/submit-plugins)
- [Vercel Sandbox](https://vercel.com/docs/vercel-sandbox)
- [Vercel Queues](https://vercel.com/docs/queues)
- [Vercel storage](https://vercel.com/docs/storage)
- [GitHub Apps](https://docs.github.com/en/apps)

