# ReproForge

[![CI](https://github.com/GhostlyGawd/reproforge/actions/workflows/ci.yml/badge.svg)](https://github.com/GhostlyGawd/reproforge/actions/workflows/ci.yml)

> Issue in. Deterministic, one-command failing reproduction out.

ReproForge turns an incomplete bug report into a verified, portable reproduction. It keeps reported facts separate from observations and inferences, tests falsifiable hypotheses within a bounded budget, verifies a machine-readable failure oracle against a negative control and three clean runs, then exports an independently validatable Repro Bundle.

The approved v2 direction is an API-first ReproForge service with plugin-first distribution: ChatGPT supplies the conversational surface under the user's subscription, while ReproForge supplies MCP tools, deterministic verification, artifacts, and isolated execution. The primary ChatGPT path will not require a user-provided OpenAI API key; the Responses API remains an optional standalone adapter. See the [v2 product specification](docs/product-spec-v2.md) and [architecture decision](docs/adr/0001-api-first-plugin-first.md).

![ReproForge showing a verified CLI reproduction, evidence board, prioritized hypothesis ledger, run history, oracle, and bundle preview](docs/evidence/milestone-4/final-desktop.png)

## Why ReproForge

- **Proof before diagnosis:** model output can propose experiments, but only deterministic application code can mark a case verified.
- **Honest terminal states:** unstable, blocked, and not-reproduced cases are product outcomes rather than hidden failures.
- **Auditable investigation:** evidence sources, hypothesis priority and history, commands, outputs, oracle version, and minimization decisions remain inspectable.
- **Portable handoff:** the final reproduction runs without an OpenAI API key or a ReproForge server.
- **Fail-closed execution:** arbitrary repositories are rejected until a real isolated runner is configured.

## Five-minute trusted demo

Prerequisites: Node.js 20.9 or newer and npm. No Docker, GitHub token, or OpenAI API key is required.

```bash
git clone https://github.com/GhostlyGawd/reproforge.git
cd reproforge
npm ci
npm run dev
```

Open [http://localhost:3000](http://localhost:3000), select **Run trusted sample**, and follow the issue-to-bundle timeline. The sample is deterministic and always identifies itself as offline.

## Run the exported reproduction directly

This command exercises the same intentionally defective spaced-path fixture represented in the sample bundle:

```bash
npm run fixture:repro -- --config "fixtures/cli-spaces/my config.json"
```

The expected result is exit code `1` with an `ENOENT` message. That failure is the successful reproduction. The negative control exits `0`:

```bash
npm run fixture:repro -- --config "fixtures/cli-spaces/config.json"
```

## Verify the repository

Install the Playwright browser once, then run the same aggregate gate used by CI:

```bash
npx playwright install chromium
npm run verify
```

The gate runs linting, strict type checking, unit and property tests, executable BDD scenarios, a production build, the deterministic eval suite, browser journeys, responsive checks, and an automated accessibility scan.

Run the benchmark alone with:

```bash
npm run eval
```

The committed four-case suite covers a verified positive, a negative no-match, an intermittent reproduction, and a misleading candidate whose oracle also matches the control.

## How it works

1. The case state machine records ingestion, inspection, hypothesis, experiment, verification, minimization, and packaging phases.
2. An offline or GPT-5.6 investigator proposes evidence-linked hypotheses and bounded typed tool calls.
3. The runner boundary accepts only the bundled fixture and allowlisted actions; external execution is unavailable.
4. A pure oracle engine evaluates captured results. Verification requires three matching candidate runs and a non-matching control.
5. The minimizer accepts only a proposed reduction that preserves the same verification result on fresh runs.
6. The bundle builder redacts, hashes, serializes, and validates the artifact contract.

![ReproForge trust architecture: the investigator proposes work while deterministic code owns execution, verification, minimization, and packaging](docs/architecture.svg)

See the [architecture and trust-boundary guide](docs/architecture.md) for the module map and data flow.

## Repro Bundle contract

```text
repro-bundle/
  REPRO.md
  reproforge.lock.json
  failure-signature.json
  reproduction.patch
  artifacts/
    redacted-run-log.jsonl
    hypothesis-ledger.json
    minimization.json
    verification-summary.json
```

The lock records the immutable revision and tree hash, dependency-lock hash, runtime, package manager, runner identity, non-secret environment facts, oracle identity and version, command, and ReproForge version. Bundle validation rejects missing files, mismatched hashes, unredacted registered secrets, or lock/oracle disagreement.

## Optional GPT-5.6 investigator

The deterministic sample does not silently switch modes. To enable the separate live investigator API, copy `.env.example` to `.env.local`, add `OPENAI_API_KEY`, and restart the app. Live mode uses `gpt-5.6-sol` through the Responses API with explicit medium reasoning, strict non-executing tools, `store: false`, and preserved response output items during continuation.

The model structures evidence and proposes experiments; it cannot execute commands, weaken the oracle, or declare verification. See the [OpenAI integration contract](docs/openai-integration.md). A live smoke test is optional and was not used for the committed offline evidence.

This key is required only for the current optional standalone Responses route. It is not a product invariant and will not be required by the subscription-first ChatGPT/MCP journey.

## Documentation

- [Product and technical specification](docs/product-spec.md)
- [Milestone roadmap and task breakdown](docs/roadmap.md)
- [Approved v2 product and platform specification](docs/product-spec-v2.md)
- [V2 delivery roadmap and GitHub milestones](docs/roadmap-v2.md)
- [API-first/plugin-first architecture decision](docs/adr/0001-api-first-plugin-first.md)
- [Test and evidence strategy](docs/test-strategy.md)
- [Architecture and trust boundaries](docs/architecture.md)
- [Security model](docs/security.md) and [security reporting policy](SECURITY.md)
- [Privacy behavior](docs/privacy.md)
- [Current limitations](docs/limitations.md)
- [Artifact and asset provenance](docs/provenance.md)
- [Release status](docs/release-status.md)
- [Completion audit](docs/completion-audit.md)
- [Contributing](CONTRIBUTING.md) and [support](SUPPORT.md)

## Project status

ReproForge is a pre-alpha Build Week prototype. The complete bundled JavaScript/TypeScript fixture journey works locally and in browser tests. External repository execution, private-repository access, persistence, authentication, and autonomous publishing are intentionally unavailable. The synthetic four-case eval is a contract check, not a claim of real-world benchmark performance.

No package, release, deployment, or stable API is promised. Consult the [release status](docs/release-status.md) and [limitations](docs/limitations.md) before relying on the project.

## License

No license has been selected. All rights are reserved until the repository owner explicitly chooses one.
