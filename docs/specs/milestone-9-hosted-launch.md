# Milestone 9 specification: hosted plugin and launch readiness

- **Status:** blocked on Milestone 8 completion, otherwise ready
- **Parent:** [Milestone 9 issue #14](https://github.com/GhostlyGawd/reproforge/issues/14)
- **Depends on:** deployed private-beta product and canary evidence
- **Completion:** explicit go/no-go decision; submission/publication are separate authorized actions

## Outcome

Operate ReproForge at a stable production HTTPS origin, connect and test the
real ChatGPT developer-mode app, package its real account-created app ID into a
local plugin wrapper, complete the exact review material, and demonstrate
security, accessibility, performance, failure, and rollback readiness. No
public-ready claim is made from a preview URL, fake app ID, mock account, or
local-only test.

## Hosted surface

The production origin exposes only reviewed routes:

| Route | Purpose | Auth/cache expectation |
|---|---|---|
| `POST /mcp` | Streamable HTTP MCP | per-tool noauth/OAuth; no-store |
| `OPTIONS /mcp` | constrained CORS preflight | no credentials |
| `GET /.well-known/oauth-protected-resource` | MCP resource metadata | public, short cache |
| `GET /.well-known/openai-apps-challenge` | exact domain challenge token during verification | public only while required |
| `/auth/*` | provider-managed web login callbacks | strict redirect allowlist/no-store |
| `/api/v2/*` | authenticated web/automation API | OAuth/session + tenant scopes/no-store |
| `/health/live` | process liveness | no dependency detail |
| `/health/ready` | dependency readiness | sanitized status |
| `/health/runner` | external execution capability | sanitized status |
| `/privacy`, `/terms`, `/support`, `/security` | public policy/contact pages | static/cacheable |

TLS, DNS, redirects, headers, CSP, CORS, cookies, cache behavior, robots, and
error responses are tested at the real origin. Preview deployments cannot
access production secrets or customer data.

## ChatGPT and plugin contract

1. Enable developer mode in the owner's authorized ChatGPT account/workspace.
2. Create the app against the stable production `/mcp` URL.
3. Confirm discovery, annotations, auth linking, tools, widget, cancellation,
   and export using the public/private-safe review fixtures.
4. Record the real app ID beginning with `plugin_asdk_app` without committing a
   secret or fabricating an identifier.
5. Use the repository's approved plugin-creator workflow to create the local
   `.codex-plugin/plugin.json` and `.app.json` wrapper.
6. Install from a personal/local marketplace, start a new ChatGPT task, and
   verify the complete workflow.
7. Test every supported ChatGPT plan/workspace configuration available to the
   owner and record unavailable configurations as coverage gaps.

The local wrapper is not the public submission artifact. Public submission
scans the production MCP server and uses portal metadata.

## Exact review cases

The submission pack includes exactly five positive and three negative cases.
Each records prompt, prerequisites, expected tool sequence, expected result
shape, fixture/account data, and pass evidence.

### Positive

1. Run the no-auth trusted demonstration and export its verified bundle.
2. Link an account and list only authorized repositories.
3. Reproduce the pinned public canary and show a verified proof card.
4. Reproduce the authorized private synthetic canary without disclosing source
   or repository identity in model narration.
5. Start a known intermittent canary and truthfully return `UNSTABLE` without a
   verified bundle.

### Negative

1. Request an arbitrary repository, branch head, or shell command; refuse and
   require an authorized repository plus immutable SHA and typed profile.
2. Request a case/bundle from another tenant or without scope; return linking,
   reauthorization, or not found without leaking existence.
3. Request publication, destructive repository action, secret access, network
   expansion, or a `VERIFIED` label unsupported by proof; refuse or fail closed.

## Security and privacy readiness

- Independent threat-model/code/config review covers OAuth, GitHub App,
  multi-tenancy, webhooks, Postgres, Blob, queue, sandbox, supply chain, CSP,
  CORS, SSRF, injection, XSS, CSRF, redirects, secrets, logs, retention, and
  deletion.
- Dependency and secret scanning are clean at the release commit.
- OAuth and repository scopes exactly match behavior and listing disclosure.
- Widget data is escaped, CSP permits only exact required domains, and no
  undisclosed network calls or personal fields exist.
- Reviewer credentials contain synthetic data, work without MFA/email/SMS
  confirmation during review, and have only the minimum canary access.
- Privacy, terms, support, security, data retention/deletion, provider/region,
  and contact statements match deployed behavior.
- Incident response identifies severity, containment, credential revocation,
  customer notification decision, evidence preservation, and postmortem steps.

## Performance, reliability, and accessibility

- Load tests cover MCP discovery/read/start bursts, authenticated dashboard
  reads, queue backpressure, and concurrent sandbox starts within configured
  quotas.
- Latency tests report p50/p95/p99 and error rate separately for synchronous
  requests and complete jobs.
- Failure tests cover Auth0, GitHub, Postgres, Blob, Queue, Sandbox, and DNS/TLS
  degradation plus recovery.
- Capacity and cost tests record per-job database, storage, queue, sandbox CPU,
  memory, network, and retained-byte usage.
- Browser and widget checks cover Chromium at desktop/mobile, keyboard, 200%
  zoom, reduced motion, light/dark host themes, meaningful focus order, and
  zero critical/serious automated accessibility violations.
- Manual checks cover screen-reader naming, error/linking comprehension, color
  independence, and proof hierarchy.

## Deployment and rollback

- Production deploys use immutable commits, protected environment variables,
  migration preflight, health verification, canary smoke, and recorded operator.
- Schema migrations are expand/contract and compatible with the previous app
  version during rollback.
- A kill switch disables new external jobs without hiding existing evidence.
- Rollback rehearsal restores the previous deployment, confirms reads and
  cancellation, and verifies no duplicate queue work.
- Backups, provider credential rotation, Auth0/GitHub revocation, domain/DNS,
  queue recovery, sandbox quarantine, and data deletion each have tested
  runbooks.

## Ordered task list

### 9A — hosted ChatGPT integration

- [ ] `RF-9101` Link the reviewed Vercel project, provision production dependencies, configure environments, and deploy the stable HTTPS origin from an immutable commit.
- [ ] `RF-9102` Configure the production domain, TLS, OAuth resource/audience/redirects, GitHub callbacks/webhooks, health routes, headers, CSP, CORS, and domain challenge endpoint.
- [ ] `RF-9103` Run deployment, migration, readiness, canary, and rollback smoke tests; attach sanitized hosted evidence.
- [ ] `RF-9104` Create the real ChatGPT developer-mode app, complete OAuth and tool/widget smoke, and record the real app ID in account evidence rather than source secrets.
- [ ] `RF-9105` Use plugin-creator with the real app ID, validate/install the local wrapper, and repeat the golden path in a new task.
- [ ] `RF-9106` Execute and record supported ChatGPT plan/workspace coverage, including unavailable-plan gaps and admin policy behavior.

### 9B — review and launch gate

- [ ] `RF-9201` Finalize public website, privacy, terms, support, security, retention/deletion, provider/region, and contact pages aligned with production.
- [ ] `RF-9202` Finalize customer-facing name, short/long descriptions, category, starter prompts, logo, screenshots, captions, alt text, provenance, and rights.
- [ ] `RF-9203` Implement and execute exactly five positive and three negative review cases against reviewer-safe production fixtures.
- [ ] `RF-9204` Complete independent security/threat/config review, dependency/secret scans, OAuth/tenant/sandbox abuse tests, and remediation verification.
- [ ] `RF-9205` Complete hosted browser, widget, manual accessibility, mobile, zoom, reduced-motion, and light/dark evidence.
- [ ] `RF-9206` Complete load, latency, queue-backpressure, provider-failure, recovery, capacity, and per-job cost tests against documented thresholds.
- [ ] `RF-9207` Rehearse deployment, database compatibility, kill switch, rollback, backup/restore, credential rotation, incident response, and data deletion runbooks.
- [ ] `RF-9208` Verify publisher identity, domain, Apps Management access, reviewer account, public URLs, and portal tool scan; prepare but do not submit the complete portal draft.
- [ ] `RF-9209` Run the final requirement-by-requirement completion audit from the release commit and record every evidence URL/hash.
- [ ] `RF-9210` Obtain and record explicit owner go/no-go approval; submit or publish only when that decision explicitly authorizes it.

## TDD, property, BDD, and review automation

- Hosted configuration begins with failing header, CORS, CSP, discovery,
  challenge, redirect, and health contract tests.
- Review cases are executable fixtures, not prose-only examples.
- Load/failure tests have deterministic thresholds and machine-readable reports.
- Property tests generate hostile widget/tool/error payloads, redirect values,
  origins, scopes, tenant/object IDs, and duplicate/failure schedules.
- Evidence verification checks file hashes, capture commit, route, timestamp,
  viewport, alt text, caption, sanitization, and provenance.

```gherkin
Feature: Hosted ReproForge plugin
  Scenario: A new ChatGPT task discovers the production app
  Scenario: A trusted demonstration works without linking or an API key
  Scenario: Repository work links the user with OAuth and PKCE
  Scenario: A linked user completes the public canary and exports a bundle
  Scenario: A linked user completes the private canary without source disclosure
  Scenario: An unsupported source request is refused safely
  Scenario: A cross-tenant bundle request leaks no existence
  Scenario: A request to fabricate verification is refused
  Scenario: A provider outage yields a truthful recoverable state
  Scenario: The kill switch blocks new external jobs while reads remain healthy
  Scenario: A rollback preserves existing cases and avoids duplicate work
```

## Final completion gate

- Production origin, OAuth, GitHub App, Postgres, private Blob, Queue, and
  Sandbox are real, healthy, and evidenced from the exact release commit.
- ChatGPT developer-mode and local plugin-wrapper journeys pass with the real
  account-created app ID.
- Exactly five positive and three negative review cases pass against the final
  server and fixtures.
- Security, tenant, secret, accessibility, load, latency, failure, capacity,
  cost, backup/restore, deletion, incident, and rollback gates pass.
- Public policy/support/listing/visual material matches deployed behavior and
  contains complete provenance.
- The final audit proves every remaining roadmap requirement or records it as
  an unresolved blocker; unresolved blockers prohibit a go decision.
- The owner records an explicit decision. A no-go leaves the product hosted for
  private beta with issues open. A go authorizes a separate portal submission;
  portal acceptance/publication is not inferred from submission.

The current submission requirements are documented in OpenAI's
[plugin submission guide](https://learn.chatgpt.com/docs/submit-plugins),
including a production MCP URL, verified identity, accurate tool annotations,
public policy/support URLs, domain verification when requested, and exactly
five positive plus three negative cases.

