# Milestone 9 hosted public-boundary evidence

This partial milestone record proves the public production boundary at
`891749b4fcce7faabf6424b565cdc45a6eb3cd3a`. GitHub's full verification gate
passed, Vercel promoted the exact preview to production deployment
`dpl_2KwXZ88yZE1fPTa9wXomJKwPiBdm`, and the stable origin was verified after
promotion.

The machine-readable [hosted boundary report](hosted-boundary-report.json)
records public route status, the closed domain-challenge response, selected
security-header assertions, and keyless MCP initialization. The challenge
route returned an empty `404` with `no-store`; it does not expose a placeholder
or verification token when no real challenge is active.

## Production visual evidence

![Desktop production ReproForge privacy notice showing bounded inputs, provider purposes, 30-day and 365-day retention, account export and deletion, and the no-analytics disclosure.](hosted-privacy-desktop.png)

![Mobile production ReproForge security page showing private vulnerability reporting, immutable repository authorization, deny-all sandbox execution, OAuth checks, and private-beta limits without horizontal overflow.](hosted-security-mobile.png)

The desktop and mobile images are real first-party captures from
`https://reproforge.vercel.app`, not generated mockups. Their exact route,
viewport, byte count, SHA-256 digest, caption, alt text, capture time, and
sanitization statement are recorded in [the manifest](manifest.json). The
built Playwright run passed all 26 browser checks, including five public-policy
checks and zero automated accessibility violations.

## Production MCP regression gate

After the visual capture, commit
`eee99411be91c05225ac0d5d95a9997ab01af068` fixed and regression-tested
decoded private-Blob reads. GitHub CI passed on the exact commit, and Vercel
promoted it as production deployment `dpl_HvTttjPzKFuYR68z45eLyeTF2Xir`.

The sanitized [production MCP gate](production-mcp-gate.json) records an
official MCP SDK run against the stable production origin. Tool discovery,
verified start, idempotent retry, durable read, matching-hash bundle export,
and `REPRO.md` presence all passed. Strict schemas also rejected arbitrary
source/command and destructive/fabricated-proof inputs, while an unknown case
was rejected or challenged. All nine live provider tests passed separately.

This protocol evidence is not presented as ChatGPT-host evidence. The review
case remains pending until it is exercised through ChatGPT developer mode.

## Intermittent canary provider gate

The public synthetic
[intermittent canary](https://github.com/GhostlyGawd/reproforge-intermittent-canary)
is pinned at `61a9fbfe6bf2e2f8c00f2f55b142dafd810b99be`. Its
[provider report](intermittent-canary-gate.json) records the real isolated
runner result: two of three candidates matched, the control remained clear,
the outcome was `UNSTABLE`, no bundle or files were created, cleanup was clean,
and no resource entered quarantine.

The corresponding review case remains pending until the repository is selected
through the GitHub App and the production flow is exercised through ChatGPT.

## Hosted load and latency gate

The [hosted load report](hosted-load-gate.json) separates the configured
private-beta capacity from a larger burst. At the configured three-active-job
limit, same-idempotency start p95 was 501.02 ms, the eventual read was 96.71
ms, no request failed, every retry shared one case/job identity, and the case
became `VERIFIED`. Both documented latency targets passed.

At 16 simultaneous duplicate starts, correctness and availability still held,
but start p95 rose to 2716.84 ms and missed the 2000 ms target. The report
retains that failed threshold as a capacity boundary; ReproForge does not claim
sub-two-second start latency above its configured private-beta limit.

## Production Auth0 and readiness gate

The sanitized [production Auth0 gate](production-auth0-gate.json) records the
exact production deployment and source commit after Auth0 and GitHub App
credentials were configured. Production liveness, dependency readiness, and a
real deny-all Vercel Sandbox runner probe all returned `200`. All seven OAuth
compatibility checks passed with DCR as the client-registration method.

A disposable strict third-party public client was registered with a `tpc_`
identifier. Auth0 accepted authorization code, refresh token, S256 PKCE, the
production RFC 8707 resource, and ReproForge scopes, then reached the expected
`login_required` boundary without a browser session. Every disposable client
was deleted. This proves machine configuration, not a completed human login or
ChatGPT-host interaction.

An initial direct Universal Login visit then exposed one missing recovery
setting: Auth0 had neither an application login URI nor a tenant default login
route. Both now point to ReproForge's server-owned `/auth/login` entry point.
The sanitized recovery canary follows the resulting `302 -> 307 -> 302 -> 200`
chain into a fresh `ReproForge Web` transaction. The only Google connection was
backed by Auth0 development keys, so it was disabled for the production web
application pending provider-owned credentials.

![Mobile Auth0 login reached from ReproForge production after the routing repair, showing email and password fields plus sign-up without a generic error, Google option, or development-key warning.](production-auth0-login-mobile.png)

This live unauthenticated capture proves that the repaired entry path renders;
it does not claim that a human login or principal-provisioning callback has
completed.

## Scope boundary

This is deliberately partial Milestone 9 evidence. It proves Auth0 tenant/DCR
configuration but does not claim a completed browser login, GitHub App
installation, signed-in public/private canaries, a real ChatGPT developer-mode
app, or ChatGPT-host screenshots. Those interactive external-account gates
remain open and prevent a completion claim.
