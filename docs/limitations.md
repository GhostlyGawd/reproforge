# Current limitations

ReproForge is a pre-alpha proof system around one complete, trusted JavaScript/TypeScript example. Its boundaries are intentional and user-visible.

## Execution

- Arbitrary local or remote repositories cannot be executed.
- The trusted runner returns validated deterministic results for the bundled fixture; separate subprocess tests prove the exported CLI reproduction itself runs.
- No Docker or managed sandbox adapter is configured.
- Dependency acquisition, network permissions, private repositories, and GitHub App authentication are not implemented.

## Investigation

- The full browser demo always uses the offline investigator.
- The live GPT-5.6 API path plans through strict, non-executing tools; it does not connect those proposals to an external execution sandbox.
- No live-key smoke evidence is committed because no key was present during milestone verification.
- Cases are not persisted, resumed, shared, or authenticated.

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

- There is no hosted deployment, stable API, published package, signed artifact, release tag, service-level agreement, or compatibility guarantee.
- Security controls required for an internet-facing multi-user service are outside the MVP.
- Browser automation covers Chromium at desktop and mobile viewports; it is not a cross-browser certification.
- No license has been selected, so reuse rights have not been granted.

The deferred delivery list is maintained in the [roadmap](roadmap.md), and release truth is recorded in [release status](release-status.md).
