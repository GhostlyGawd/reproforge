# ReproForge

> Issue in. Deterministic, one-command failing reproduction out.

ReproForge is an evidence-first developer tool that turns an incomplete bug report into a verified, portable reproduction. It inspects a repository, forms falsifiable hypotheses, runs bounded experiments through an isolated runner, verifies a machine-readable failure oracle, and exports a maintainer-ready Repro Bundle.

## Status

ReproForge is under active development for the OpenAI Build Week Developer Tools track. The current repository is pre-alpha; do not use it to execute untrusted repositories until an isolated runner is configured.

## What makes it different

- It must prove a failure before calling a bug reproduced.
- Verification is deterministic and independent of model confidence.
- The final output runs without an AI model.
- Observations, hypotheses, experiments, and conclusions remain auditable.
- `NOT_REPRODUCED` and `UNSTABLE` are honest product outcomes.

## Delivery documents

- [Product and technical specification](docs/product-spec.md)
- [Milestone roadmap and task breakdown](docs/roadmap.md)
- [Test and evidence strategy](docs/test-strategy.md)

## Intended MVP

The first complete slice supports a bundled, trusted JavaScript/TypeScript fixture. External repository execution remains disabled until the Docker-compatible isolated-runner adapter can be exercised. GPT-5.6 Sol is integrated through the OpenAI Responses API behind typed boundaries, with a deterministic offline investigator for local development and judge testing without credentials.

## License

No license has been selected yet. All rights are reserved until the repository owner explicitly chooses one.
