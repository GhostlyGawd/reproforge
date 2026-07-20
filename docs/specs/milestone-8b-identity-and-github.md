# Milestone 8B specification: identity and GitHub authorization

- **Status:** in progress on `agent/identity-github-authorization`
- **Parent:** [Milestone 8 issue #13](https://github.com/GhostlyGawd/reproforge/issues/13)
- **Depends on:** durable tenant-keyed repositories and audit events
- **Unblocks:** external source acquisition and authenticated ChatGPT tools

## Outcome

Authenticate ChatGPT and web users with standards-conformant OAuth, resolve
every request to one tenant principal, and authorize repositories through a
separate least-privilege GitHub App installation. Tokens never appear in model
content, widget metadata, browser storage, logs, queue messages, artifacts, or
bundles.

## Trust model

Auth0 is the authorization server and ReproForge MCP is the protected resource.
ChatGPT is an OAuth client using authorization code + PKCE. ReproForge verifies
access tokens but never issues them. GitHub installation authorization is a
second trust domain and is never inferred from the user's Auth0 identity alone.

### MCP OAuth requirements

- Publish HTTPS protected-resource metadata at
  `/.well-known/oauth-protected-resource` with the canonical MCP resource and
  exact authorization server/scopes.
- Configure the authorization server discovery document for ChatGPT-supported
  client identification, preferring CIMD and supporting the provider's reviewed
  fallback when required.
- Preserve the MCP `resource` parameter so issued tokens have the expected
  audience.
- Support authorization code + S256 PKCE and the exact ChatGPT redirect URI
  shown for the app.
- Verify signature, issuer, audience/resource, expiry, not-before, subject,
  tenant, and scope on every protected request.
- Return a `401` challenge and tool-level `_meta["mcp/www_authenticate"]` with
  sanitized error and description when linking or reauthorization is needed.
- Define `securitySchemes` per tool. The trusted synthetic demo may retain
  `noauth`; repository, tenant, and bundle operations require OAuth scopes.

### Product scopes

| Scope | Allows | Does not allow |
|---|---|---|
| `reproforge:cases:read` | read the caller tenant's cases/jobs/proof | start, cancel, repository access |
| `reproforge:cases:write` | start and cancel bounded work | admin actions or other tenants |
| `reproforge:bundles:read` | read/export the tenant's verified bundles | source export or unverified bundle claims |
| `reproforge:repositories:read` | list installations/repositories and pin revisions | install the GitHub App or change GitHub settings |
| `reproforge:account:delete` | request tenant data deletion after explicit confirmation | immediate silent destructive action |

### Principal and tenant rules

- `(issuer, subject)` maps to one principal and one active tenant context.
- A request without an unambiguous active tenant fails closed.
- Tenant and principal IDs come from verified claims/server mappings, never
  tool inputs.
- Object lookup always includes tenant scope and returns `NOT_FOUND` rather
  than revealing another tenant's identifier.
- Admin/support impersonation is absent from private beta; future support access
  requires a separate audited design.

## GitHub App contract

The GitHub App requests only:

- repository metadata: read;
- repository contents: read; and
- issues: read when issue-number ingestion is enabled.

No write permission, Actions secret access, organization administration,
webhook mutation, or user OAuth token is required for reproduction.

- Users install the app through a server-generated state-bound setup flow.
- Callback state is single-use, short-lived, bound to tenant and principal,
  and rejected on mismatch or replay.
- The service stores installation/repository identifiers and permission
  metadata, not installation access tokens.
- Installation tokens are minted just in time, short-lived, repository-scoped,
  held in memory only, redacted from errors, and destroyed after source
  acquisition.
- Every start rechecks installation state, repository selection, permission,
  and immutable commit availability.
- Removed installations immediately block new work and prevent artifact/source
  reads that depend on live GitHub authorization; existing retained artifacts
  follow the disclosed retention policy.
- GitHub webhook signatures and delivery IDs are verified. Duplicate deliveries
  are idempotent and installation suspension/removal revokes authorization.

## MCP tool v2 contract

| Tool | Auth | Behavior |
|---|---|---|
| `start_reproduction` | noauth for trusted sample; `cases:write` + `repositories:read` for repository source | start/reuse one bounded job from a strict source union |
| `list_authorized_repositories` | `repositories:read` | list sanitized repositories and default branches available to the tenant |
| `get_reproduction` | `cases:read` | read current progress and proof for one tenant case |
| `cancel_reproduction` | `cases:write` | idempotently request cancellation of active work |
| `export_repro_bundle` | `bundles:read` | export a verified bundle only |

Repository start input contains a selected repository identifier, a full
40-character commit SHA, issue evidence, a typed execution profile, and bounded
budget. It never accepts a GitHub token, arbitrary shell string, environment
secret, callback URL, or unrestricted network policy.

## Ordered task list

- [x] `RF-8201` Add failing OAuth metadata, challenge, and token-verification contract tests using generated signing keys and a local issuer fixture.
- [x] `RF-8202` Implement strict Auth0/resource configuration, protected-resource metadata, discovery validation, cached JWKS retrieval, and full JWT verification behind `AccessTokenVerifier`.
- [x] `RF-8203` Implement principal/tenant resolution and application authorization policies; remove caller identity from all protected transport inputs.
- [x] `RF-8204` Upgrade MCP tool schemas, per-tool `securitySchemes`, scope checks, linking/reauthorization challenges, and sanitized unauthenticated/forbidden errors while preserving the no-auth trusted demo.
- [ ] `RF-8205` Add authenticated web session handling and repository-connection UI without placing access or installation tokens in browser storage.
- [ ] `RF-8206` Create the least-privilege GitHub App manifest/setup specification and implement state-bound installation callbacks and webhook verification.
- [ ] `RF-8207` Implement installation/repository persistence, live authorization checks, just-in-time installation token minting, and immutable revision resolution behind provider-neutral ports.
- [ ] `RF-8208` Add revocation/suspension handling, scope-change behavior, token/JWKS rotation tests, and audit events for login, linking, repository access, and authorization denial.
- [ ] `RF-8209` Add cross-tenant, confused-deputy, callback replay, webhook replay, and secret non-disclosure property tests.
- [ ] `RF-8210` Complete OAuth browser, MCP Inspector auth, GitHub installation, and public/private repository-selection integration evidence in development accounts.
- [ ] `RF-8211` Update privacy, security, setup, architecture, tool documentation, screenshots, and the milestone evidence manifest.

## TDD and property requirements

Failing tests precede token, callback, or tool behavior. Generated properties
run at least 300 cases for authorization boundaries:

- arbitrary invalid signatures, issuers, audiences, times, algorithms, subjects,
  tenants, and scopes never authorize a protected operation;
- an authorization decision is invariant under untrusted caller/tool identity
  fields because those fields are ignored or rejected;
- no tenant/object combination returns another tenant's existence or data;
- arbitrary callback state replay, expiry, mutation, or tenant mismatch fails;
- arbitrary webhook duplication or reordering produces the same installation
  authorization state;
- registered secret values and credential-shaped strings never appear in any
  MCP content, structured content, `_meta`, response, log, audit metadata,
  queue payload, artifact, or bundle;
- authorization removal immediately denies all newly evaluated repository
  operations; and
- idempotent start under token refresh retains one case/job.

## Executable BDD

```gherkin
Feature: Authenticated repository authorization
  Scenario: The trusted sample remains available without linking an account
  Scenario: A repository request prompts ChatGPT account linking
  Scenario: A linked user sees only repositories authorized to their tenant
  Scenario: A token with the wrong audience is rejected
  Scenario: A token without repository scope triggers reauthorization
  Scenario: An expired token never starts a job
  Scenario: Replayed GitHub installation state is rejected
  Scenario: A suspended installation blocks new work
  Scenario: A user cannot read a case from another tenant
  Scenario: No token appears in the widget, logs, or exported bundle
```

## Acceptance and evidence gate

- Auth0 development-tenant discovery, S256 PKCE, ChatGPT client registration,
  resource audience, and redirect flow complete with real tokens.
- MCP Inspector and ChatGPT development smoke both receive the correct linking
  challenge and complete a protected read.
- GitHub App permission screenshots/API evidence match the documented
  read-only permissions.
- A public repository and a private canary are listed only after installation
  authorization; removal blocks both.
- Token rotation and JWKS refresh work without accepting an invalid key.
- Cross-tenant and secret-leak suites pass with the required property counts.
- Existing trusted fixture tests remain green and keyless.
- All docs and visuals contain synthetic/public canary data only.
- The milestone PR is green and merged before 8C begins.

## Current official requirements

The implementation follows the current
[Apps SDK authentication guide](https://developers.openai.com/apps-sdk/build/auth),
including protected-resource metadata, authorization-server discovery,
authorization code + PKCE, resource audience, per-tool security schemes, and
runtime authentication challenges. GitHub authorization follows
[GitHub Apps documentation](https://docs.github.com/en/apps).

