# Milestone 8C specification: isolated repository execution

- **Status:** implementation and development-provider evidence complete on `agent/isolated-execution`; merge remains gated by the full PR checks and Milestone 8B live account evidence
- **Parent:** [Milestone 8 issue #13](https://github.com/GhostlyGawd/reproforge/issues/13)
- **Depends on:** durable jobs, private artifacts, authenticated tenant, and live repository authorization
- **Unblocks:** real public/private repository reproductions

## Outcome

Acquire one authorized immutable GitHub revision and execute a constrained
JavaScript/TypeScript reproduction profile in a disposable Vercel Sandbox
microVM. The web application host never checks out or executes the repository.
No production credential is present when repository code can run.

## Supported first production profile

The first profile is deliberately explicit rather than arbitrary:

```ts
type NodeRepositoryProfile = {
  ecosystem: "node";
  nodeVersion: "22" | "24";
  packageManager: "npm";
  lockfile: "package-lock.json";
  workspace?: string;
  reproductionScript: string;
  controlScript: string;
  testNamePattern?: string;
};
```

Scripts must be declared in the selected `package.json`. The service converts
them to executable-plus-argument arrays and never invokes a shell string.
Repositories without an exact supported lockfile/profile return
`UNSUPPORTED_SOURCE`; they are not silently run with looser policy.

## Execution protocol

### Phase 1 — authorization and immutable acquisition

1. Recheck tenant, installation, repository, and exact 40-character commit SHA.
2. Reserve quota and create an attempt/lease before provisioning compute.
3. Create a fresh sandbox with no inherited environment credentials.
4. Keep the sandbox deny-all from creation. In the trusted application service,
   mint a short-lived, repository-scoped installation token and use it only for
   GitHub's exact immutable archive endpoint.
5. Accept only GitHub's HTTPS `codeload.github.com` temporary redirect, never
   forward authorization to it, stream at most 100 MiB, discard the token, and
   inject only the compressed archive bytes into the sandbox.
6. Verify the archive digest, exact revision, path root, file/byte limits, and
   absence of unsafe archive traversal before extraction.
7. Verify the token is absent from environment,
   process arguments visible to later commands, Git config, remotes, files,
   logs, and collected output.

### Phase 2 — dependency acquisition without repository-code egress

1. Parse and validate `package.json` and `package-lock.json` as data.
2. Reject unsupported URL dependencies, missing integrity, traversal, excessive
   dependency count/size, and disallowed package-manager configuration.
3. Allow only the approved npm registry endpoints while populating a sandbox
   package cache with lifecycle scripts disabled.
4. Verify lockfile integrity and record dependency/archive hashes.
5. Change the network policy to deny all.
6. Perform the offline install and lifecycle/build steps under deny-all egress.

No untrusted repository script runs while GitHub, npm, or any other network
destination is reachable.

### Phase 3 — bounded experiments

- Run as a non-production sandbox identity with no mounted host paths, container
  socket, or cloud metadata access.
- Invoke only resolved executables with separated argument arrays and a fixed
  workspace root.
- Enforce per-command and total wall time, CPU, memory, disk, process count,
  output bytes, artifact bytes, and tool-call/run limits.
- Start with one negative control and three clean candidate runs. Every run gets
  a clean worktree or snapshot derived from the immutable source.
- Capture stdout/stderr separately, truncate deterministically, redact before
  persistence, and retain the original byte counts/hashes.
- Cancellation stops active commands and the sandbox; a resource or total-time
  breach becomes non-retryable `BUDGET_EXHAUSTED`, while provider interruption
  remains a distinct bounded-retry operational state.
- Model output may propose typed experiments but cannot execute directly or set
  domain status.

### Phase 4 — proof, artifact export, and cleanup

1. Pass sanitized run results to the existing pure oracle and verifier.
2. Permit `VERIFIED` only after the versioned oracle matches all required clean
   candidate runs and does not match the control.
3. Build and validate the Repro Bundle without provider access.
4. Upload content-addressed artifacts before transitioning the job to success.
5. Stop the sandbox in a `finally` path; record sanitized provider resource and
   network usage plus cleanup status.
6. A failed cleanup quarantines the attempt and alerts operations; it never
   changes proof truth.

## Default limits

Private-beta defaults are versioned policy, not user-editable raw values:

| Limit | Default |
|---|---:|
| source archive | 100 MiB / 25,000 entries |
| extracted workspace | 500 MiB |
| dependency cache | 1 GiB |
| sandbox | 2 vCPU / 4 GiB memory |
| processes | 128 |
| each command | 120 seconds |
| complete attempt | 15 minutes |
| stdout + stderr per run | 2 MiB aggregate, capped at 1 MiB per stream, after deterministic truncation |
| artifact set | 100 MiB |
| candidate runs | 3 required, 5 maximum |
| tool/experiment calls | 12 maximum |

Provider and plan limits may be stricter; readiness exposes the effective
limits. A limit breach returns `BUDGET_EXHAUSTED`, `UNSUPPORTED_SOURCE`, or a
sanitized runner failure and does not retry indefinitely.

## Threat model

The runner assumes repository files, names, symlinks, archives, lockfiles,
package metadata, dependency scripts, test code, process output, and generated
artifacts are malicious.

Required defenses cover:

- archive/path traversal and absolute paths;
- symlink/hardlink escape and special files;
- decompression bombs and file-count exhaustion;
- fork/process bombs, infinite output, disk/memory/CPU exhaustion;
- network exfiltration during dependency and execution phases;
- credential discovery in environment, process arguments, config, filesystem,
  metadata endpoints, logs, and errors;
- command/argument injection and workspace escape;
- artifact poisoning, MIME confusion, and hash mismatch;
- cancellation races, stale leases, duplicate deliveries, and provider loss;
- cross-tenant source/artifact reuse; and
- attempts to forge oracle evidence or a `VERIFIED` result.

## Ordered task list

- [x] `RF-8301` Write failing source/profile/execution-plan schemas and provider-neutral acquisition/sandbox contracts.
- [x] `RF-8302` Implement canonical GitHub source descriptors, immutable revision resolution, safe archive/path validation, and source provenance records.
- [x] `RF-8303` Implement the Vercel Sandbox adapter using the current SDK with explicit creation, command, file, network, usage, and stop behavior.
- [x] `RF-8304` Implement just-in-time private/public source acquisition and prove GitHub credentials are absent before any repository code executes.
- [x] `RF-8305` Implement lockfile validation and the two-stage dependency acquisition/offline installation protocol.
- [x] `RF-8306` Implement typed command planning, clean control/candidate workspaces, separated executable/args invocation, and immutable environment provenance.
- [x] `RF-8307` Enforce CPU/memory/disk/process/network/time/output/artifact/run/tool limits with stable sanitized failure mappings.
- [x] `RF-8308` Implement streaming cancellation, timeout, provider-interruption recovery, sandbox quarantine, and unconditional cleanup.
- [x] `RF-8309` Integrate run evidence with the existing oracle, verifier, minimizer, bundle builder, durable artifact store, and terminal job transaction.
- [x] `RF-8310` Add adversarial unit/property/security tests for archives, paths, symlinks, commands, outputs, secrets, limits, state races, and forged proof.
- [x] `RF-8311` Add sandbox-provider integration tests for trusted-host bounded acquisition, byte-only sandbox injection, execution deny-all, credential absence, limits, cancellation, and cleanup.
- [x] `RF-8312` Add BDD and a sanitized public-repository canary bundle; update threat model, runbook, architecture, limitations, and evidence.

## TDD and property requirements

Behavior begins with failing tests for traversal, command separation, network
phase ordering, secret absence, and deterministic verification.

At least 500 generated adversarial cases cover:

- normalized archive and workspace paths never escape their root;
- symlinks, hardlinks, devices, FIFOs, and absolute paths never enter the
  execution workspace;
- arbitrary package metadata cannot add an executable or argument outside the
  typed plan;
- network policy always reaches deny-all before the first repository-controlled
  script and never reopens during execution;
- arbitrary secret values cannot survive acquisition into later environment,
  config, remote URLs, logs, output, artifacts, or bundles;
- output truncation is deterministic and preserves the recorded original hash
  and byte count;
- duplicate delivery/cancellation/timeout sequences yield one terminal attempt
  and one cleanup decision;
- no runner/provider result can directly construct a `VERIFIED` case; and
- bundle identity is stable for identical sanitized evidence and environment.

Security tests include malicious fixture archives and repositories created for
the test suite. They contain only synthetic secrets and payloads.

## Executable BDD

```gherkin
Feature: Isolated repository reproduction
  Scenario: An authorized public Node repository produces a verified bundle
  Scenario: An authorized private Node repository produces the same proof shape
  Scenario: A repository without an immutable revision is rejected
  Scenario: An unsupported lockfile is blocked before sandbox execution
  Scenario: A traversal archive is rejected
  Scenario: Dependency acquisition runs with scripts disabled
  Scenario: Repository code runs only after network becomes deny-all
  Scenario: A reproduction that matches its control is blocked
  Scenario: An intermittent repository produces UNSTABLE
  Scenario: A job exceeding its budget stops and reports BUDGET_EXHAUSTED
  Scenario: Cancellation stops commands and cleans the sandbox
  Scenario: Provider interruption never fabricates verification
  Scenario: No GitHub token appears in evidence or the bundle
```

## Acceptance and evidence gate

- Official current Sandbox SDK calls are verified against a development Vercel
  project; guessed or mock-only API behavior cannot close provider tasks.
- Network observations prove source acquisition occurs only in the trusted host,
  the sandbox never receives a GitHub credential or GitHub egress, registry-only
  cache population runs with scripts disabled, and repository execution is
  deny-all.
- A synthetic secret planted in acquisition is absent from every later
  observable surface.
- Resource, output, timeout, cancellation, and cleanup tests pass in real
  sandboxes.
- Public canary proof includes immutable SHA, environment/policy versions,
  negative control, three clean runs, and a valid content-addressed bundle.
- All malicious fixtures fail with expected stable outcomes and no host process
  executes repository code.
- Existing trusted-fixture verification remains unchanged.
- Full offline and authorized provider gates pass; evidence is sanitized and
  provenance-recorded.
- The backend boundary has no meaningful screenshot state. The committed
  machine-readable bundle, provider transcript summary, and updated trust
  architecture are the applicable evidence; hosted UI/ChatGPT captures remain
  8D/9 work.
- The milestone PR is green and merged before 8D begins.

RF-8308 additionally has direct development-provider proof: one prepared
Node 24 sandbox was snapshotted with the provider-required 24-hour minimum
retention, two deny-all microVMs were restored, a mutation in the first restore
was absent from the second, both isolated commands completed, and both
sandboxes plus the source snapshot were cleaned. Provider and resource
identifiers are deliberately omitted from this sanitized record.

RF-8309 has direct database-backed integration proof: an authorized immutable
repository request is persisted with its versioned oracle and execution
profile, dispatched without running in the request process, consumed under an
exclusive durable lease, derived into proof by the verifier, and transitioned
to `SUCCEEDED` only after the content-addressed bundle is readable from the
private artifact store. Idempotent replay does not rerun the sandbox, and a
durable cancellation request aborts active runner work before committing one
`CANCELLED` terminal state. The production build composes the same worker with
Neon, private Vercel Blob, Vercel Queues, the GitHub App credential broker, and
Vercel Sandbox; no OpenAI API credential is present in this execution path.

RF-8310 has 2,000 generated adversarial executions across four 500-run
properties. They cover normalized and escaping archive paths, symlinks,
hardlinks and special files, arbitrary package metadata and command separation,
network phase ordering, exact secret removal, deterministic output truncation
and original hashes, forged provider verification fields, stable bundle
identity, and duplicate/cancellation/failure sequences that converge on one
terminal and cleanup decision.

RF-8311 has direct development-provider proof. A public repository's exact
commit archive was resolved and downloaded through GitHub's documented
temporary redirect on the trusted host, bounded before upload, injected into a
deny-all Vercel Sandbox, hash-matched across the boundary, and parsed by `tar`
inside the microVM. GitHub egress remained denied, no GitHub or Vercel identity
variable appeared in observable sandbox surfaces, a 3 MiB output retained its
original byte count and SHA-256 while truncating to the per-stream budget, and
an active infinite process was cancelled. Two fresh restores preserved the
immutable marker, excluded the first restore's mutation from the second, and
cleaned both microVMs and the snapshot. The combined live provider gate passed
all nine tests: three isolated-execution tests and six durable-provider tests.

RF-8312 has executable proof across 13 repository-specific BDD scenarios. The
complete suite passes 39 scenarios and 283 steps. A real public canary acquired
the exact `GhostlyGawd/reproforge` revision
`804d2da174060b40981e6a0437e6b212fc64d36d`, prepared its locked npm
dependencies with lifecycle scripts disabled, snapshotted the prepared source,
then ran one negative control and three candidates in four fresh deny-all
microVMs. The oracle produced `VERIFIED`, cleanup was clean, and the portable
11,187-byte bundle at
[`docs/evidence/milestone-8c/public-canary-bundle.json`](../evidence/milestone-8c/public-canary-bundle.json)
has outer SHA-256
`7d6908cfe7a2f34916b739fbde0c46ec71d5dab7872bbcfbc37b7d6ea10eb52f`.
The bundle contains no synthetic canary secret, GitHub/Vercel credential name,
provider resource identifier, local path, or provider URL.

The provider gate also drove two red-to-green corrections. Vercel's network
header transformation requires a paid plan, so acquisition was strengthened to
keep the sandbox deny-all and inject bytes after trusted-host download. Vercel
also rejects creating an existing directory, so every experiment now receives
a unique trusted-supervisor directory. Neither correction requires an OpenAI
API key or a Vercel plan upgrade.

