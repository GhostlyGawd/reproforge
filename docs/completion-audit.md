# Trusted-slice completion audit

- **Audit date:** 2026-07-20
- **Scope:** approved trusted-fixture MVP, REST/MCP adapters, Milestone 8A durable foundation, 8B authorization implementation, and 8C isolated-runner implementation/provider proof
- **Verification baseline:** 341 offline Vitest tests, 39 BDD scenarios / 283 steps, 18 Playwright tests, production build, 4/4 deterministic eval fixtures, and 9/9 live Neon/Blob/Queue/Sandbox provider tests

“Satisfied” below means satisfied for the explicitly approved bundled-fixture scope. It does not imply arbitrary-repository support or production readiness.

## Functional requirements

| Requirement | Status | Implementation and evidence |
|---|---|---|
| RF-01 Case ingestion | Satisfied | `runTrustedSample` constructs the validated fixture case, immutable revision facts, evidence, and explicit `6`-tool / `3`-run budget; sample and browser tests exercise it. |
| RF-02 Evidence classification | Satisfied | `evidenceSchema` requires source and `reported`, `observed`, `inferred`, or `unknown` classification; the evidence board renders all sample classes without erasing unknowns. |
| RF-03 Hypothesis ledger | Satisfied | Strict schemas require evidence links, expected/falsifying signals, priority, and monotonically ordered status history; dedicated tests reject inconsistent histories. |
| RF-04 Runner isolation boundary | Satisfied for the supported profile, fail-closed otherwise | The bundled fixture remains allowlisted. Authorized immutable GitHub sources use a provider-tested Vercel Sandbox runner with bounded acquisition, lifecycle-script-disabled dependency preparation, deny-all fresh snapshot runs, cancellation/limits, unconditional cleanup, and no sandbox credential. Arbitrary/unsupported inputs fail closed. |
| RF-05 Typed experimentation | Satisfied | GPT tools are strict schemas and record evidence/hypothesis proposals. They expose no shell, filesystem mutation, source-write, or publishing capability. Recorded transport tests verify continuation and permissions. |
| RF-06 Deterministic oracle engine | Satisfied | Pure composite oracle evaluation is unit- and property-tested independently from every investigator. |
| RF-07 Clean-run verification | Satisfied | The verifier owns outcome classification, requires three matching candidates and a non-matching control, and exposes repeatability and environment identity. Unit, property, and BDD tests cover all outcomes. |
| RF-08 Minimization | Satisfied | Fresh candidate/control results are re-verified for every proposal. Only verified reductions can be accepted; a 250-case property asserts that invariant and BDD rejects over-reduction. |
| RF-09 Bundle export | Satisfied | Bundle schema 1.1 is strict, content-addressed, redacted, materialized into eight required files, and independently validated. Provenance hashes and oracle/lock agreement are enforced. |
| RF-10 Investigation UI | Satisfied | The browser shows phase, classifications, prioritized hypothesis history, experiments, budget, oracle, three runs, control, minimization, terminal result, command, and bundle. Playwright covers desktop, mobile, keyboard, reduced motion, cancellation, and Axe. |
| RF-11 Offline and live investigators | Satisfied with noted verification gap | Offline mode is deterministic and fully tested. The explicit GPT-5.6 Responses adapter and recorded transport contracts are tested without credentials. A live-key smoke was not run because no key was present. |
| RF-12 Evaluation mode | Satisfied | Strict JSON fixtures and `npm run eval` measure status accuracy, false positives/negatives, repeatability, recorded duration, and bundle completeness across positive, negative, unstable, and misleading cases. |
| RF-13 Headless case/job service | Satisfied for offline and durable trusted scope | Browser and REST v2 share `CaseOperations`; caller-scoped idempotency, conflicts, reads, jobs, export, sanitized failures, and serialization are contract- and property-tested. Offline mode is process-local; complete hosted configuration selects the durable composition. |
| RF-14 ChatGPT MCP adapter | Satisfied for local trusted scope; protected account smoke pending | Stateless Streamable HTTP exposes exactly five closed, annotated no-auth/OAuth tools. SDK clients prove the no-key start/retry/read/export journey and protected authorization challenges; the historical independent Inspector evidence covers the original three-tool trusted slice and must be refreshed in the hosted milestone. |
| RF-15 Embedded MCP App | Satisfied for local trusted scope | The exact self-contained resource uses the MCP Apps bridge, closed CSP, escaped DOM rendering, read/export controls, responsive layouts, 100 hostile-payload properties, Playwright, and Axe. |
| RF-16 Durable provider foundation | Satisfied for development providers | Nine forward migrations, tenant-keyed repositories, serializable idempotency, private content-addressed artifacts, outbox/Queue delivery, leases/recovery, quotas, cancellation, retention/deletion, audit, readiness, and backup/restore have unit/property/BDD proof. Six live durable-provider tests prove Neon concurrency/recovery/readiness, private Blob denial/round-trip/deletion, identifier-only Queue acceptance, durable restart identity, and destructive restore/re-hash behavior. |
| RF-17 Identity and GitHub authorization | Implemented; live account gate pending | OAuth protected-resource metadata, JWT/scope/principal mapping, signed PKCE/account and GitHub installation state, repository selection, immutable revision checks, token brokering, revocation ordering, audit, and secret-safety tests are implemented. A real Auth0 browser/MCP Inspector and GitHub installation/revocation canary is still required. |
| RF-18 Isolated repository execution | Satisfied for implementation and development-provider proof | Three live Sandbox tests include the full exact public canary: bounded source, locked dependencies, one control plus three fresh deny-all candidates, deterministic `VERIFIED` proof, portable 11,187-byte bundle, credential scan, cancellation/output boundaries, snapshot isolation, and clean resource deletion. Thirteen repository BDD scenarios and 2,000 adversarial property executions cover the fail-closed contract. |

## Success criteria

| Criterion | Result |
|---|---|
| Trusted journey under five minutes | Pass: one-click offline browser journey completes in seconds in automated production-browser verification. |
| Three matching verification reruns | Pass: `3 / 3`, repeatability `1.0`. |
| Negative control | Pass: `0` oracle matches. |
| Required bundle files | Pass: `8 / 8`, benchmark completeness `1.0`. |
| Property-test depth | Pass: durable identity, queue ordering, leases, quota, retention, backup mutation, and migration-version properties use at least 250 generated sequences; configuration/redaction and port contracts run larger generated sets. |
| Critical BDD scenarios | Pass: 39 scenarios and 283 steps. |
| Real development providers | Pass: 9/9 live tests (6 durable + 3 isolated), nine applied migrations, one full public canary, and sanitized cleanup postconditions. |
| Judge/sample setup under five minutes | Pass by documented path: Node + `npm ci` + `npm run dev`, with no key or Docker. Environment download speed remains external. |
| Critical automated accessibility findings | Pass: full Axe analysis returns zero violations on the verified result. |

## Build Week judging alignment

| Criterion | Evidence |
|---|---|
| Technological implementation | Typed GPT-5.6 boundary, explicit model configuration, strict tool contracts, pure oracle engine, property-tested invariants, verification-preserving minimizer, provenance-rich portable bundle, deterministic evals, and CI. |
| Design | Complete responsive issue-to-proof journey with evidence taxonomy, prioritized hypothesis ledger, budget/oracle visibility, honest terminal states, keyboard operation, reduced motion, and committed real-app screenshots. |
| Potential impact | Converts maintainer triage from an open-ended evidence conversation into a reusable failing artifact with control and repeatability proof. Impact remains a product hypothesis; no adoption metric is claimed. |
| Idea quality | Treats reproduction as a proof artifact rather than an assistant answer, while keeping the model valuable for evidence synthesis and bounded experiment design. |

## Explicitly deferred or unverified

- General repository execution remains unavailable until live account and
  composed hosted gates pass; arbitrary URL/branch/command/unsupported-profile
  execution remains permanently outside the supported contract.
- No live OpenAI smoke test was performed during this milestone; recorded contracts and offline behavior are the committed evidence.
- No ChatGPT developer-mode smoke or local plugin wrapper was completed because a reachable HTTPS URL and real account-created `plugin_asdk_app…` ID were unavailable. The MCP implementation and evidence do not substitute a host claim.
- The four synthetic eval fixtures are regression coverage, not an external benchmark.
- Durable provider resources and automatic branch previews exist for development acceptance, but no stable public application deployment, tenant authentication, plugin/publication, release, package publication, license, or service-level promise exists.
- Minimization is local to supplied proposals and does not claim global minimality.

## Audit decision

The trusted-fixture MVP, local v2 REST/MCP slices, and Milestone 8A durable
foundation plus the 8C runner satisfy their current code/provider proof gates
when the exact milestone commit passes CI and is merged. The 8B implementation
does not satisfy its live account gate yet. Deferred account proof, composed
hosting, general/private repository use, and publication remain visibly
fail-closed and do not weaken either the trusted sample or public-canary claim.
