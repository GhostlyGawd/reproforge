# Submission working set

This directory holds review material that can be prepared without submitting
or publishing the app. Public submission remains a separate owner decision.

[`review-cases.json`](review-cases.json) is the strict execution contract for
exactly five positive and three negative cases. Each case records the reviewer
prompt, prerequisites, expected MCP tool sequence, fixture boundary, result
shape, safety assertions, contract references, and hosted pass-evidence state.
Run `npm run verify:review-cases` to validate the pack and `npm test -- --run
tests/review-case-pack.test.ts` for its TDD and property checks.

Public canary provenance may be committed. Private repository identity,
private commit, foreign-tenant case ID, OAuth credentials, and provider
identifiers remain environment-bound and must never be copied into this public
working set. Every case is currently marked `pending_hosted`; the status can
change to `passed` only with real production and ChatGPT-host evidence.

[`listing.json`](listing.json) is the portal-ready listing draft and includes
the production URLs, customer-facing copy, proposed category, four starter
prompts, release notes, an original logo, and checksummed desktop/mobile
production widget captures. The category remains subject to the portal's live
options. Publisher identity and country availability are intentionally unset,
and the draft is explicitly not submitted.
