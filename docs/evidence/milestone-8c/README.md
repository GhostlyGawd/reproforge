# Milestone 8C — isolated execution evidence

This directory records the sanitized provider proof for ReproForge's isolated
repository runner. The machine-readable summary is
[`manifest.json`](manifest.json). It proves the backend execution boundary; the
public proof bundle and user-facing visual journey remain RF-8312 work and are
not claimed here.

## Verified provider boundary

| Gate | Observed result |
|---|---|
| Trusted-host acquisition | GitHub public canary `GhostlyGawd/reproforge` at immutable commit `fd4c4be62d37fd76167c3b9a71d64c979f33e28e` returned a documented temporary archive redirect; the response was streamed under the 100 MiB limit. |
| Credential boundary | Authorization applies only to the fixed `api.github.com` archive request and is not forwarded to `codeload.github.com`; only compressed bytes cross into the sandbox. |
| Sandbox source integrity | The host SHA-256 matched `sha256sum` inside a real Vercel Sandbox and the archive was readable by `tar`. |
| Network isolation | The sandbox was deny-all before upload; an attempted GitHub request failed and the policy never opened for source acquisition or execution. |
| Observable secret surfaces | Process environment, arguments, Git configuration, and workspace file names contained no synthetic acquisition secret, `GITHUB_TOKEN`, or `VERCEL_OIDC_TOKEN`. |
| Output budget | A 3 MiB stream retained the configured 1 MiB per-stream share of the 2 MiB aggregate budget while preserving the original byte count and full SHA-256. |
| Cancellation | Aborting an active infinite process returned the stable `PROVIDER_INTERRUPTED` boundary and did not leave the provider test running. |
| Fresh isolation | Two microVMs restored from one prepared snapshot; both saw the immutable marker and neither inherited the first restore's mutation. |
| Cleanup | Both restores and the source snapshot were deleted; no quarantine record was required. |
| Durable providers | The same gate also passed six live Neon, private Blob, Queue, concurrency, restore, and cleanup tests. |

The direct command was `npm run test:providers`: 8 tests passed, 0 failed, and
0 skipped. Provider resource names, session IDs, database identifiers, object
keys, URLs, headers, credentials, and response bodies are deliberately omitted.

## Red-to-green provider findings

The first canary rejected Vercel's secure header transformation because that
feature is unavailable on the project's Hobby plan. The runner was redesigned
to download a bounded compressed archive in the trusted application host and
inject only bytes into a sandbox that remains deny-all. This removes the paid
plan dependency and strengthens the credential boundary.

The next canary found that Vercel rejects `mkdir` when a prior experiment's
trusted supervisor directory already exists. A failing local contract test now
models that behavior, and every run receives a unique trusted-supervisor
directory. The repeated live gate then passed all eight tests.

## Evidence boundary

This is backend evidence, so a screenshot would add no meaningful proof. Its
observable contract is provider behavior, byte/hash identity, network denial,
bounded output, cancellation, fresh-state behavior, and cleanup. RF-8312 still
requires the sanitized public-repository proof bundle; hosted browser and
ChatGPT visuals remain required by the launch milestone.

