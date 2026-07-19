# Security model

## Current trust boundary

ReproForge is safe to run only with its bundled demonstration fixture. The application does not execute arbitrary repositories. `UnavailableExternalRunner` rejects every external request, and the trusted fixture runner rejects unknown fixture IDs and actions.

The standalone `fixtures/cli-spaces/repro.mjs` command reads only the path supplied to it. It intentionally contains a path-truncation defect for demonstration and must not be reused as production CLI code.

## Controls implemented

- External execution fails closed when no isolated backend exists.
- Investigator tools are strict data contracts, not shell or filesystem tools.
- The OpenAI client is initialized only for an explicit live request with a configured key.
- Live Responses requests use `store: false`.
- API errors return generic messages and do not echo credentials or raw exceptions.
- Bundle materialization redacts registered secrets before serialization.
- Canonical hashes cover contract-relevant bundle content and provenance fields.
- Oracle and lock identifiers must agree before bundle validation succeeds.
- CI rejects high-severity dependency audit findings and runs the full verification gate.

## Not yet safe or supported

- Cloning or executing a user-supplied repository.
- Attaching to a production environment.
- Supplying production credentials, customer datasets, or private source code.
- Multi-user or internet-facing operation without authentication, rate limiting, storage controls, and a deployment review.
- Treating redaction as a substitute for excluding secrets at input time.

## Requirements for a future external runner

An external adapter must execute in a disposable sandbox as a non-root identity, drop Linux capabilities, impose CPU, memory, disk, process, and time limits, default-deny network after an approved acquisition phase, receive no ambient host secrets, and have no host checkout or container-socket mount. The application must verify runner health and provenance and continue to fail closed on any ambiguity.

## Dependency and model risk

Dependencies are pinned by `package-lock.json` and audited in CI. A clean audit does not prove the absence of vulnerabilities. GPT output is untrusted structured input: schemas, permission checks, and deterministic verification remain mandatory even when the model response appears plausible.

For reporting instructions, see the repository [security policy](../SECURITY.md).
