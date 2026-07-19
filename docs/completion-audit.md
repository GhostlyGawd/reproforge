# MVP completion audit

- **Audit date:** 2026-07-19
- **Scope:** approved trusted-fixture MVP in product specification 1.1
- **Verification baseline:** 46 Vitest tests, 7 BDD scenarios / 32 steps, 8 Playwright tests, production build, and 4/4 deterministic eval fixtures

“Satisfied” below means satisfied for the explicitly approved bundled-fixture scope. It does not imply arbitrary-repository support or production readiness.

## Functional requirements

| Requirement | Status | Implementation and evidence |
|---|---|---|
| RF-01 Case ingestion | Satisfied | `runTrustedSample` constructs the validated fixture case, immutable revision facts, evidence, and explicit `6`-tool / `3`-run budget; sample and browser tests exercise it. |
| RF-02 Evidence classification | Satisfied | `evidenceSchema` requires source and `reported`, `observed`, `inferred`, or `unknown` classification; the evidence board renders all sample classes without erasing unknowns. |
| RF-03 Hypothesis ledger | Satisfied | Strict schemas require evidence links, expected/falsifying signals, priority, and monotonically ordered status history; dedicated tests reject inconsistent histories. |
| RF-04 Runner isolation boundary | Satisfied, fail-closed | The bundled fixture has an allowlisted runner; unknown fixtures/actions fail. `UnavailableExternalRunner` rejects all external work. No isolated external backend is claimed. |
| RF-05 Typed experimentation | Satisfied | GPT tools are strict schemas and record evidence/hypothesis proposals. They expose no shell, filesystem mutation, source-write, or publishing capability. Recorded transport tests verify continuation and permissions. |
| RF-06 Deterministic oracle engine | Satisfied | Pure composite oracle evaluation is unit- and property-tested independently from every investigator. |
| RF-07 Clean-run verification | Satisfied | The verifier owns outcome classification, requires three matching candidates and a non-matching control, and exposes repeatability and environment identity. Unit, property, and BDD tests cover all outcomes. |
| RF-08 Minimization | Satisfied | Fresh candidate/control results are re-verified for every proposal. Only verified reductions can be accepted; a 250-case property asserts that invariant and BDD rejects over-reduction. |
| RF-09 Bundle export | Satisfied | Bundle schema 1.1 is strict, content-addressed, redacted, materialized into eight required files, and independently validated. Provenance hashes and oracle/lock agreement are enforced. |
| RF-10 Investigation UI | Satisfied | The browser shows phase, classifications, prioritized hypothesis history, experiments, budget, oracle, three runs, control, minimization, terminal result, command, and bundle. Playwright covers desktop, mobile, keyboard, reduced motion, cancellation, and Axe. |
| RF-11 Offline and live investigators | Satisfied with noted verification gap | Offline mode is deterministic and fully tested. The explicit GPT-5.6 Responses adapter and recorded transport contracts are tested without credentials. A live-key smoke was not run because no key was present. |
| RF-12 Evaluation mode | Satisfied | Strict JSON fixtures and `npm run eval` measure status accuracy, false positives/negatives, repeatability, recorded duration, and bundle completeness across positive, negative, unstable, and misleading cases. |

## Success criteria

| Criterion | Result |
|---|---|
| Trusted journey under five minutes | Pass: one-click offline browser journey completes in seconds in automated production-browser verification. |
| Three matching verification reruns | Pass: `3 / 3`, repeatability `1.0`. |
| Negative control | Pass: `0` oracle matches. |
| Required bundle files | Pass: `8 / 8`, benchmark completeness `1.0`. |
| Property-test depth | Pass: every property declares at least 100 generated runs; high-value serialization/redaction properties use 300 and minimization uses 250. |
| Critical BDD scenarios | Pass: 7 scenarios and 32 steps. |
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

- Arbitrary repository execution remains unavailable until an isolated runner exists.
- No live OpenAI smoke test was performed during this milestone; recorded contracts and offline behavior are the committed evidence.
- The four synthetic eval fixtures are regression coverage, not an external benchmark.
- No deployment, authentication, persistence, release, package publication, license, or service-level promise exists.
- Minimization is local to supplied proposals and does not claim global minimality.

## Audit decision

The trusted-fixture MVP satisfies its specification and proof gates when the milestone branch passes CI and is merged. Deferred capabilities remain visibly fail-closed and do not weaken the verified sample claim.
