# Current limitations

ReproForge is a pre-alpha proof system with one generally available trusted
JavaScript/TypeScript example and a provider-verified, narrowly constrained
public repository canary. Its boundaries are intentional and user-visible.

## Execution

- Arbitrary local checkouts, repository URLs, branch heads, shell commands,
  ecosystems, package managers, and lockfiles cannot be executed.
- The generally available trusted runner remains limited to the bundled fixture.
  The repository path requires a server-authorized GitHub installation,
  immutable 40-character commit, exact Node 22/24 + npm +
  `package-lock.json` profile, declared control/reproduction scripts, and the
  durable isolated composition.
- The Vercel Sandbox adapter has direct development-provider proof for a tiny
  public canary: bounded trusted-host acquisition, dependency preparation with
  lifecycle scripts disabled, deny-all snapshot restores, one control, three
  candidate runs, output/cancellation limits, proof, and cleanup. That is not a
  claim that general public repositories are enabled or safe.
- Public acquisition mints no GitHub credential. Private source support and
  GitHub App authorization exist in code, but live Auth0/GitHub account,
  installation, repository-selection, and revocation evidence is still missing.
- The extracted workspace is capped at 500 MiB, archive input at 100 MiB,
  supported lock metadata is deliberately restrictive, and provider/plan
  limits may be lower. Unsupported sources fail closed.

## Investigation

- The full browser demo always uses the offline investigator.
- The live GPT-5.6 API path plans through strict, non-executing tools. It is not
  an autonomous repository executor and cannot grant access or set proof status.
- No live-key smoke evidence is committed because no key was present during milestone verification.
- Local offline/test cases remain process-local and disappear on restart.
  Preview/production composition is durable across adapter reconstruction and
  uses Neon, private Blob, and Queue, but only for the bundled synthetic fixture.
- The durable foundation has live development-provider proof for transactions,
  concurrency, restart/retry identity, private object access/deletion,
  identifier-only Queue publication, dependency readiness, and tenant
  backup/restore. This is not a hosted availability or production-load claim.
- The no-auth trusted sample still uses an anonymous public synthetic tenant.
  OAuth/principal and GitHub authorization contracts are implemented for the
  protected path, but they are not safe for private/customer data until the
  live account and composed hosted gates pass.
- The ChatGPT/MCP adapter implements the trusted journey and widget, but it has not been connected to a real ChatGPT developer-mode app because no reachable HTTPS endpoint or account-created `plugin_asdk_app…` ID was available.
- The no-auth MCP endpoint uses one anonymous synthetic-demo caller scope. It is not user identity, tenant isolation, quota enforcement, or authorization.
- The standalone `/widget-preview` route renders the exact MCP resource with real service data for browser evidence; it is not a screenshot of the widget inside ChatGPT.

## Verification and minimization

- P0 oracles cover exit code, output, structured JSON, assertion identity, and boolean composition over captured results.
- Three candidate runs are the fixed MVP policy; statistical flakiness analysis is not implemented.
- Minimization chooses the largest verified reduction among supplied proposals with a deterministic tie-break. It does not search the full input space or claim mathematical minimality.
- Environment provenance is represented in the bundle contract, but the trusted sample uses fixture identities rather than a hermetic container image digest.

## Evaluation

- The committed benchmark contains four synthetic fixtures designed to exercise status classification and bundle completeness.
- A 4/4 result is a regression-contract result, not evidence of accuracy on real-world repositories or issue corpora.
- Recorded durations are fixture data and are not wall-clock performance measurements.

## Product readiness

- REST v2 and MCP are implemented draft contracts, not stability guarantees.
  Managed development storage, Queue, and Sandbox resources plus automatic
  branch previews exist for provider validation, but there is no stable public
  application deployment, packaged developer-mode app, published plugin,
  published package, signed artifact, release tag, service-level agreement, or
  compatibility guarantee.
- Security controls required for an internet-facing multi-user service are outside the MVP.
- Browser automation covers Chromium at desktop and mobile viewports; it is not a cross-browser certification.
- No license has been selected, so reuse rights have not been granted.

The deferred delivery list is maintained in the [roadmap](roadmap.md), and release truth is recorded in [release status](release-status.md).
