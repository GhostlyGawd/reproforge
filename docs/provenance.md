# Provenance

## Product source

ReproForge was created in this repository for OpenAI Build Week under the repository owner's direction, with OpenAI Codex used as an implementation and documentation assistant. Commit and pull-request history is the authoritative record of changes and review. No proprietary third-party repository or customer data was used for the bundled demonstration.

## Demonstration data

- The CLI spaced-path issue, stack signal, repository identity, commands, and run results are synthetic fixtures created for ReproForge.
- `fixtures/cli-spaces/repro.mjs` is an original intentionally defective test fixture. Its truncation behavior is not copied production code.
- The four evaluation cases are synthetic contract fixtures. Their recorded durations are illustrative input data, not measured benchmark timings.
- `tests/fixtures/openai/investigation-turns.json` is a sanitized recorded-contract shape used by a fake transport; it is not presented as a live model transcript.

## Visual assets

- Product screenshots are first-party captures of local and production
  ReproForge surfaces populated only with synthetic sample data. Milestone 7's
  preview is labeled as a local harness; the later `chatgpt-host` record is
  separately labeled and checksummed as a real ChatGPT capture.
- `docs/architecture.svg` is an original repository asset created for the implemented architecture.
- Each evidence manifest records the source commit, capture method, timestamp, viewport, SHA-256 digest, sanitization statement, and rights statement.
- No stock photography, generated people, customer data, or third-party logo is
  used as ReproForge artwork. The sanitized ChatGPT screenshots are used only
  as host-integration evidence and are explicitly identified as such.

## Dependencies and references

Runtime and development dependencies are declared in `package.json`, resolved in `package-lock.json`, and retain their own upstream licenses. ReproForge documentation links to official OpenAI and Build Week material where those contracts inform the design. A dependency's license does not license ReproForge itself.

## License status

No license has been selected for ReproForge. This provenance record establishes origins; it does not grant reuse rights. See [release status](release-status.md).
