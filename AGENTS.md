# ReproForge contributor instructions

These instructions apply to the entire repository.

## Product invariants

- ReproForge never labels a case `VERIFIED` from model output alone.
- Verification requires a machine-readable oracle, a negative control, and repeatable clean runs.
- Never execute an untrusted external repository directly on the host.
- Keep reported facts, observed facts, inferences, and unknowns distinct.
- Preserve `NOT_REPRODUCED`, `UNSTABLE`, `BLOCKED`, and `CANCELLED` as first-class outcomes.
- Exported Repro Bundles must not require OpenAI access to run.

## Development workflow

- Use npm and preserve `package-lock.json`.
- Prefer TypeScript with strict compiler settings.
- Write a failing test before behavior changes when practical.
- Use Vitest for unit and integration tests.
- Use fast-check for state-machine, oracle, minimization, hashing, and serialization invariants.
- Use executable Gherkin scenarios for user-visible investigation outcomes.
- Use Playwright for critical browser journeys and visual evidence.
- Keep OpenAI and runner integrations behind interfaces so tests stay deterministic and offline.
- Never weaken an oracle, assertion, or schema merely to make a test pass.

## Required validation

Run the narrowest relevant tests while iterating. Before publishing a milestone, run:

```bash
npm run check
```

For milestones that change the UI, also run the browser suite and capture sanitized evidence under `docs/evidence/<milestone>/`.

## Documentation and evidence

- Keep README commands, supported scope, architecture, security boundaries, and screenshots aligned with working behavior.
- Every visual artifact needs a caption, alt text, capture date, source commit, and provenance note.
- Do not include secrets, personal paths, private repository contents, customer data, or invented screenshots.
- Record known gaps plainly, especially when Docker or an OpenAI API key is unavailable.

