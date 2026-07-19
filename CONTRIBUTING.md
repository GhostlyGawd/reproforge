# Contributing to ReproForge

ReproForge welcomes focused bug reports and pull requests, subject to the repository's current no-license status. Before contributing, review the [product invariants](AGENTS.md), [specification](docs/product-spec.md), and [security boundary](docs/security.md).

## Local setup

Use Node.js 20.9 or newer and npm:

```bash
git clone https://github.com/GhostlyGawd/reproforge.git
cd reproforge
npm ci
npx playwright install chromium
npm run verify
```

## Change workflow

1. Open or reference a narrowly scoped issue.
2. Create a branch from current `main`.
3. Add a failing unit example, property, or BDD scenario before implementation when applicable.
4. Implement the smallest change that preserves the proof and execution boundaries.
5. Run narrow tests while iterating and `npm run verify` before requesting review.
6. Update the README, architecture, limitations, and evidence when behavior or claims change.

Pull requests should describe the user impact, the observed red test, verification commands and counts, security/privacy implications, deferred work, and visual evidence for user-visible changes.

## Test selection

- Vitest examples cover schemas and deterministic application behavior.
- fast-check properties cover state, oracle, verification, hashing, redaction, serialization, and minimization invariants. Use at least 100 generated cases.
- Cucumber scenarios cover observable terminal outcomes and bundle behavior.
- Playwright covers the critical browser journey, accessibility, responsive layout, keyboard interaction, and reduced motion.
- Eval fixtures belong in `evals/fixtures/` and must pin an expected outcome without network access.

Never weaken an oracle, schema, permission check, or assertion only to make a test pass. Never execute an untrusted repository on the host.

## Evidence and sensitive data

Commit only sanitized, reproducible evidence. Screenshots require a manifest with source commit, timestamp, viewport, method, digest, alt text, sanitization, and rights provenance. Do not include credentials, private source, customer data, personal paths, or live issue content without explicit rights and review.

Report suspected vulnerabilities privately according to [SECURITY.md](SECURITY.md), not in a public issue.
