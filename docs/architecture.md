# Architecture and trust boundaries

![ReproForge architecture showing proposal, execution, deterministic proof, audit, and bundle boundaries](architecture.svg)

## Design rule

GPT-5.6 may organize evidence and propose bounded experiments. It does not own execution permissions, case transitions, oracle evaluation, minimization acceptance, or the `VERIFIED` label. Those decisions remain in deterministic, schema-validated application code.

## Runtime flow

1. The browser requests the bundled sample from the Next.js application.
2. The case orchestrator advances a validated state machine and retains a sourced evidence ledger, prioritized hypotheses, tool budget, and event history.
3. The investigator interface selects either the deterministic offline implementation or the explicit live Responses API implementation.
4. Strict investigator tools record evidence and hypotheses. They are proposal contracts and cannot execute shell commands or modify repositories.
5. All execution crosses the runner interface. The current trusted fixture accepts one fixture ID and two allowlisted actions. The external adapter throws a typed unavailable error.
6. The pure oracle engine evaluates captured exit codes and output. The verifier requires a non-matching control and three clean matching candidates.
7. The minimizer evaluates proposed reductions with the same verifier and accepts only a reduction that remains verified. It claims local reduction, never global minimality.
8. The bundle builder redacts registered secrets, computes canonical hashes, validates lock/oracle consistency, and emits the versioned artifact set.

## Module map

| Responsibility | Implementation |
|---|---|
| Case state and transitions | `src/domain/case.ts` |
| Evidence and hypothesis contracts | `src/domain/evidence.ts` |
| Failure-oracle evaluation | `src/domain/oracle.ts` |
| Control and repeatability verification | `src/domain/verification.ts` |
| Verification-preserving reduction | `src/domain/minimization.ts` |
| Bundle hashing, redaction, and validation | `src/domain/bundle.ts` |
| Trusted and unavailable runners | `src/infrastructure/runner.ts` |
| Trusted golden-path orchestration | `src/application/sample-case.ts` |
| Investigator implementations | `src/ai/` |
| Deterministic benchmark | `src/evaluation/` and `evals/fixtures/` |
| Browser surface and API routes | `src/app/` and `src/components/` |

## Data and persistence

The MVP has no database, user accounts, or server-side case persistence. The trusted sample is constructed per request. A bundle is returned as validated JSON/files and downloaded by the browser. The optional OpenAI transport sends only the explicit investigation request and uses `store: false`.

## Deployment shape

The application can run as a conventional Next.js Node process. That does not enable arbitrary repository execution. A future external runner must be a separately isolated service with default-deny network, resource limits, no ambient credentials, no host checkout mount, and a health check that fails closed.

## Invariants

- Model confidence is never evidence of reproduction.
- Unknown or unallowlisted execution is rejected.
- Changing an oracle version invalidates earlier proof.
- A control matching the failure signature blocks verification.
- A partial candidate match is unstable, not verified.
- A Repro Bundle is usable and validatable without OpenAI access.

See [security](security.md), [privacy](privacy.md), and [limitations](limitations.md) for the current operating envelope.
