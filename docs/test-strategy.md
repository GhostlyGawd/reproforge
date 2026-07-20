# ReproForge test and evidence strategy

## 1. Objective

Tests must establish that ReproForge produces trustworthy evidence, not merely that screens render or model calls succeed. The verification engine and bundle contract remain independently testable without Docker, network access, GitHub credentials, or an OpenAI API key.

## 2. Test pyramid

### Unit tests

Use Vitest for schemas, transitions, oracle evaluation, redaction, hashing, bundle validation, and investigator adapters.

### Property tests

Use fast-check for invariants with large input spaces:

- invalid state transitions never mutate a case;
- terminal states never transition to active states;
- equivalent composite oracles produce equivalent results;
- oracle evaluation is deterministic and pure;
- changing an oracle version invalidates prior verification;
- redaction is idempotent and never reveals a registered secret;
- canonical serialization is stable across key insertion order;
- bundle hashes change when contract-relevant content changes;
- repeated caller-scoped idempotency keys execute at most once;
- terminal jobs never return to active states;
- schema-valid case snapshots survive JSON round trips;
- the requested clean-run policy is preserved in the proof;
- arbitrary widget/tool text survives JSON embedding without creating an executable script boundary;
- accepted minimization never converts a passing control into a matching failure; and
- verification status agrees with candidate/control run counts.

Each property runs at least 100 generated cases locally and in CI. Higher counts are appropriate for small pure functions.

### Executable BDD

Use Gherkin and Cucumber for user-observable behavior. Scenarios cover:

- a candidate that matches three times and whose control does not match becomes verified;
- an intermittent candidate becomes unstable;
- a candidate that never matches becomes not reproduced;
- a control that matches the same oracle blocks verification;
- an external repository request without an isolated runner becomes blocked;
- an over-reduced reproduction is rejected;
- a verified case exports a complete, independently valid bundle;
- a subscription-first trusted start succeeds without an OpenAI API key and reuses retries;
- another caller cannot read a case it does not own;
- changed input under the same idempotency key is rejected;
- ChatGPT discovers exactly three bounded MCP tools with no repository, command, or API-key input;
- an MCP retry executes the trusted fixture once and returns the same case/job proof; and
- the MCP App resource uses the required HTML profile with no external network domains.

Step definitions invoke application services, not browser selectors. Browser journeys separately prove the UI.

Durable BDD steps boot PostgreSQL-in-WebAssembly through PGlite. Vitest runs
PGlite files serially, and the Cucumber entrypoint applies V8's
`--no-memory-protection-keys` only to that test process. This avoids a known
V8 ThreadIsolation/JIT-page teardown race observed by other high-churn PGlite
suites ([upstream harness record](https://github.com/prisma/prisma-next/pull/814));
it does not alter application or production runtime flags. A fatal V8
abort is a failed gate and is never treated as a test retry success.

### Browser and accessibility tests

Use Playwright for the critical sample journey at desktop and mobile sizes. Assertions cover:

- loading the sample;
- starting and cancelling a run;
- understanding evidence classifications;
- reaching the verified result;
- accessing the one-command reproduction and bundle contents;
- starting, retrying, polling, reading, and exporting through REST v2;
- initializing, discovering, and calling through the live Next.js `/mcp` route;
- rendering the actual MCP App resource at desktop and narrow ChatGPT-style widths;
- keyboard navigation and focus visibility; and
- zero critical automated accessibility violations.

## 3. TDD loop

1. Add or identify a failing example, property, or scenario.
2. Run the narrow test and record the expected failure.
3. Implement the smallest behavior that satisfies the contract.
4. Run the narrow test, then adjacent suites.
5. Refactor without weakening schemas, oracles, or assertions.
6. Run `npm run check` before committing the milestone.

Milestone pull requests should state which tests were observed failing first. Generated build output and transient test artifacts are never committed as proof.

## 4. Test doubles

- `TrustedFixtureRunner` is a deterministic allowlisted boundary over bundled captured results; subprocess tests independently execute the exported one-command fixture.
- `FakeRunner` deterministically produces run results for unit, property, and BDD tests.
- `OfflineInvestigator` is a deterministic sample implementation, not a mock presented as live AI.
- `RecordedOpenAITransport` replays sanitized API contract fixtures.
- Live OpenAI smoke tests are opt-in and skipped when `OPENAI_API_KEY` is absent.

No test double may be labeled as a live external runner or live GPT-5.6 session in the UI.

## 5. Milestone evidence

### Non-visual evidence

- Commands and exit status.
- Test counts and named suites.
- Property-test run counts.
- BDD scenario and step counts.
- Production build result.
- Benchmark metrics when applicable.

### Visual evidence

Visual evidence is required when a milestone changes user-visible behavior. Store it under:

```text
docs/evidence/<milestone>/
  README.md
  manifest.json
  desktop-*.png
  mobile-*.png
```

The evidence README and manifest record:

- capture date and UTC timestamp;
- exact source commit;
- route and viewport;
- test or scenario that established the state;
- concise alt text and caption;
- capture method;
- sanitization statement; and
- rights/provenance statement.

Screenshots must show real rendered application state. Concept art, generated mockups, logos, and file presence are not completion evidence.

## 6. Completion gate

A milestone is complete when:

- every in-scope task has a passing test or documented non-code verification;
- `npm run check` passes;
- user-visible work has committed visual evidence;
- known limitations are updated;
- the pull request describes impact and verification; and
- the reviewed milestone branch is merged into `main`.

## 7. Production-boundary gates

Milestones 8 and 9 add provider-backed gates defined in the
[remaining delivery plan](specs/README.md). In-memory, recorded, and fake
adapters remain valuable for TDD but cannot prove real Postgres transactions,
private object access, queue delivery, OAuth/PKCE, GitHub installation
authorization, sandbox network isolation, hosted ChatGPT behavior, backup
restore, or rollback.

Provider suites run only with authorized development/staging credentials and
synthetic or public fixtures. A skipped provider suite reports why it skipped
and leaves its task unchecked. CI secrets are scoped to the minimum environment
and never reach forked pull requests, logs, screenshots, fixtures, or artifacts.

