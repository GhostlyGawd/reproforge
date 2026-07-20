# Security policy

## Supported versions

ReproForge has no published release. Security fixes, when available, target the latest commit on `main`; older commits and forks are not supported.

## Reporting a vulnerability

Do not disclose exploit details in a public issue. If GitHub displays a **Report a vulnerability** option for this repository, use that private channel. Otherwise, contact the repository owner through a private method listed on the [GhostlyGawd GitHub profile](https://github.com/GhostlyGawd) and include the repository name, affected commit, impact, reproduction, and suggested mitigation.

Do not include real credentials or customer data. Use a synthetic proof of concept. The owner may request clarification, but this pre-alpha project makes no response-time or bounty commitment.

## Current boundary

The bundled trusted fixture is the only generally available path. Source code
also contains a narrow immutable-GitHub/Node/npm runner with direct public-
canary proof in disposable deny-all Vercel Sandbox microVMs, but live account
authorization and a stable hosted service are not yet complete. Do not use it
for arbitrary or private/customer repositories. See the complete
[security model](docs/security.md) and [limitations](docs/limitations.md) before
running or deploying the application.
