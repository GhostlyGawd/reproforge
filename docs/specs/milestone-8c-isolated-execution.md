# Milestone 8C specification: isolated repository execution

- **Status:** in progress on `agent/isolated-execution`; live merge remains blocked on 8B evidence
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
4. Set network policy to GitHub-only acquisition endpoints.
5. Mint a short-lived, repository-scoped installation token in the application
   service and use it only for the clone/archive fetch process.
6. Verify the checked-out `HEAD`, archive digest, path root, file/byte limits,
   and absence of unsafe archive traversal.
7. Destroy the token reference and verify it is absent from environment,
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
- Cancellation stops active commands and the sandbox; timeout and provider
  loss produce truthful retryable/blocked operational states.
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
| stdout + stderr per run | 2 MiB retained after deterministic truncation |
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
- [ ] `RF-8304` Implement just-in-time private/public source acquisition and prove GitHub credentials are absent before any repository code executes.
- [ ] `RF-8305` Implement lockfile validation and the two-stage dependency acquisition/offline installation protocol.
- [ ] `RF-8306` Implement typed command planning, clean control/candidate workspaces, separated executable/args invocation, and immutable environment provenance.
- [ ] `RF-8307` Enforce CPU/memory/disk/process/network/time/output/artifact/run/tool limits with stable sanitized failure mappings.
- [ ] `RF-8308` Implement streaming cancellation, timeout, provider-interruption recovery, sandbox quarantine, and unconditional cleanup.
- [ ] `RF-8309` Integrate run evidence with the existing oracle, verifier, minimizer, bundle builder, durable artifact store, and terminal job transaction.
- [ ] `RF-8310` Add adversarial unit/property/security tests for archives, paths, symlinks, commands, outputs, secrets, limits, state races, and forged proof.
- [ ] `RF-8311` Add sandbox-provider integration tests for acquisition-only egress, execution deny-all, credential absence, limits, cancellation, and cleanup.
- [ ] `RF-8312` Add BDD and a sanitized public-repository canary bundle; update threat model, runbook, architecture, limitations, and evidence.

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
- Network observations prove GitHub-only acquisition, registry-only cache
  population with scripts disabled, and deny-all repository execution.
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
- The milestone PR is green and merged before 8D begins.

