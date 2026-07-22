# Trusted-slice completion audit

- **Audit date:** 2026-07-21
- **Scope:** trusted fixture, REST/MCP adapters, durable providers, production identity/GitHub authorization, isolated public-canary execution, and the anonymous ChatGPT-host product path
- **Verification baseline:** 472 passing offline Vitest tests with 9 live-provider tests explicitly skipped in the keyless gate, 50 BDD scenarios / 358 steps, 26 milestone browser checks, 162 verified local links, 28 evidence JSON files, production build, 4/4 deterministic eval fixtures, and prior 9/9 live Neon/Blob/Queue/Sandbox provider proof

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
| RF-11 Offline and live investigators | Satisfied for the subscription-first product; optional API smoke remains deferred | Offline mode is deterministic and fully tested. The production ChatGPT journey proves the primary product without a user API key. The optional service-owned GPT-5.6 Responses adapter retains recorded transport coverage; no live API-key smoke is claimed. |
| RF-12 Evaluation mode | Satisfied | Strict JSON fixtures and `npm run eval` measure status accuracy, false positives/negatives, repeatability, recorded duration, and bundle completeness across positive, negative, unstable, and misleading cases. |
| RF-13 Headless case/job service | Satisfied for offline and durable trusted scope | Browser and REST v2 share `CaseOperations`; caller-scoped idempotency, conflicts, reads, jobs, export, sanitized failures, and serialization are contract- and property-tested. Offline mode is process-local; complete hosted configuration selects the durable composition. |
| RF-14 ChatGPT MCP adapter | Satisfied for the production trusted path; protected host cases pending | Stateless Streamable HTTP exposes exactly five closed, annotated no-auth/OAuth tools. A real developer-mode app connected to the production endpoint with authorization `None`; ChatGPT invoked the trusted start/export sequence, rendered the proof, and produced the portable ZIP without a ReproForge account or user API key. The repository-local Codex wrapper is schema-validated and drift-tested against the evidenced app ID. Protected OAuth/repository and negative host cases remain separate. |
| RF-15 Embedded MCP App | Satisfied for the production trusted host path | The exact self-contained resource uses the MCP Apps bridge, closed CSP, a unique production widget origin, escaped DOM rendering, read/export controls, responsive layouts, 100 hostile-payload properties, Playwright, and Axe. The real widget rendered inside ChatGPT with sanitized visual proof. |
| RF-16 Durable provider foundation | Satisfied for development providers | Nine forward migrations, tenant-keyed repositories, serializable idempotency, private content-addressed artifacts, outbox/Queue delivery, leases/recovery, quotas, cancellation, retention/deletion, audit, readiness, and backup/restore have unit/property/BDD proof. Six live durable-provider tests prove Neon concurrency/recovery/readiness, private Blob denial/round-trip/deletion, identifier-only Queue acceptance, durable restart identity, and destructive restore/re-hash behavior. |
| RF-17 Identity and GitHub authorization | Satisfied for the production public web slice; protected ChatGPT/private gates pending | OAuth protected-resource metadata, JWT/scope/principal mapping, signed PKCE/account and GitHub installation state, selected repository authorization, immutable revision checks, token brokering, revocation ordering, audit, and secret-safety tests are implemented. A real browser login and read-only GitHub App installation expose exactly two selected public repositories in production. Anonymous ChatGPT needs no login; protected ChatGPT OAuth and private-review evidence remain open. |
| RF-18 Isolated repository execution | Satisfied for implementation, provider proof, and the signed-in production public canary | Three live Sandbox tests and the later production run include the exact public canary: bounded immutable source, locked zero-dependency preparation, one control plus three fresh deny-all candidates, deterministic `VERIFIED` proof, a private content-addressed bundle, cancellation/output boundaries, snapshot isolation, and clean resource deletion. The production case and sanitized visual record are under `docs/evidence/production-public-canary`. |

## Success criteria

| Criterion | Result |
|---|---|
| Trusted journey under five minutes | Pass: one-click offline browser journey completes in seconds in automated production-browser verification. |
| Three matching verification reruns | Pass: `3 / 3`, repeatability `1.0`. |
| Negative control | Pass: `0` oracle matches. |
| Required bundle files | Pass: `8 / 8`, benchmark completeness `1.0`. |
| Property-test depth | Pass: durable identity, queue ordering, leases, quota, retention, backup mutation, and migration-version properties use at least 250 generated sequences; configuration/redaction and port contracts run larger generated sets. |
| Critical BDD scenarios | Pass: 50 scenarios and 358 steps. |
| Real development providers | Pass: 9/9 live tests (6 durable + 3 isolated), nine applied migrations, one full public canary, and sanitized cleanup postconditions. |
| Judge/sample setup under five minutes | Pass for the hosted trusted path: select the connected ReproForge app in ChatGPT and use the documented prompt; no ReproForge account, user API key, Node, or Docker is required. Local setup remains `npm ci` + `npm run dev`. |
| Critical automated accessibility findings | Pass: full Axe analysis returns zero violations on the verified result. |

## Build Week judging alignment

| Criterion | Evidence |
|---|---|
| Technological implementation | Typed GPT-5.6 boundary, explicit model configuration, strict tool contracts, pure oracle engine, property-tested invariants, verification-preserving minimizer, provenance-rich portable bundle, deterministic evals, and CI. |
| Design | Complete responsive issue-to-proof journey with evidence taxonomy, prioritized hypothesis ledger, budget/oracle visibility, honest terminal states, keyboard operation, reduced motion, and committed real-app screenshots. |
| Potential impact | Converts maintainer triage from an open-ended evidence conversation into a reusable failing artifact with control and repeatability proof. Impact remains a product hypothesis; no adoption metric is claimed. |
| Idea quality | Treats reproduction as a proof artifact rather than an assistant answer, while keeping the model valuable for evidence synthesis and bounded experiment design. |

## Explicitly deferred or unverified

- Selected, authorized repositories now execute through the composed production
  account path for the supported Node/npm profile. Arbitrary
  URL/branch/command/unsupported-profile execution remains permanently outside
  the supported contract.
- No live service-owned OpenAI API-key smoke is claimed. It is optional and is
  not required by the subscription-first ChatGPT path, which now has real host
  evidence.
- The ChatGPT developer-mode app, anonymous connection, trusted prompt, widget,
  bundle export, and repository-local Codex wrapper are complete. Protected
  OAuth host flows and seven remaining hosted review cases are not claimed.
- The four synthetic eval fixtures are regression coverage, not an external benchmark.
- A stable public review deployment, production tenant authentication, selected
  GitHub authorization, and a developer-mode ChatGPT app exist. No public
  listing/publication, release, package publication, license, compatibility
  guarantee, or service-level promise exists.
- Minimization is local to supplied proposals and does not claim global minimality.

## Audit decision

The trusted-fixture MVP, v2 REST/MCP slices, durable foundation, identity
boundary, selected GitHub authorization, and isolated runner satisfy their
current code/provider gates. The signed-in production public canary passes end
to end with a verified private bundle, and the anonymous ChatGPT product path
passes end to end with a rendered proof widget and portable ZIP. Protected
ChatGPT/private review evidence, the remaining seven host cases, portal
submission, and publication remain visibly open and do not weaken the two
completed product paths.
