# Privacy behavior

## Offline trusted sample

The default local sample uses synthetic issue text and a bundled fixture. It
requires no account, API key, telemetry service, database, or third-party
request. In `offline` and `test` modes, REST v2 and MCP case/job state is held
in memory for one server process and disappears on restart. A downloaded bundle
is written only where the browser or MCP App user chooses to save it.

In the subscription-first path, ChatGPT calls ReproForge with a fixed sample ID, bounded budget, idempotency key, or case ID. ReproForge does not accept the user's ChatGPT credential or OpenAI API key, and the tools do not accept free-form conversation text, repository contents, or customer data. The embedded widget has no allowed external network or asset domains. ChatGPT itself processes the conversation under the user's plan and applicable OpenAI controls; that host processing is separate from ReproForge's synthetic tool payload.

## Hosted durable trusted sample

Preview/production mode is opt-in and requires a complete managed-provider
configuration. It stores tenant-keyed synthetic case/job/idempotency/quota,
sanitized evidence, audit/outbox metadata, and restore state in Neon Postgres;
content-addressed bundle bytes are private in Vercel Blob. Vercel Queue receives
only opaque tenant, case, job, event, kind, and schema identifiers. It receives
no conversation, source body, command, token, evidence, or bundle content.

The default customer-data retention fields are 30 days for cases, jobs,
idempotency, run evidence, outbox events, and trusted bundle artifacts. Audit,
quota, deletion, and principal records use a separate 365-day default. The
internal deletion workflow removes eligible customer-class records and private
objects and retains one sanitized audit tombstone. Backup/restore archives keep
object bodies separate from the canonical manifest and verify every digest.
The authenticated `/account` page and account API expose a quota-bounded
portable export and an explicit-confirmation deletion request. Export requires
a quiescent tenant and returns private object bytes inside the integrity-checked
download; it is never cached. Deletion suspends new activity, requests
cancellation of active work, deletes private objects before database rows, and
remains retryable after a provider failure. There is no public
retention-administration or operator UI.

Current live provider evidence uses only generated synthetic identifiers and
the bundled fixture. Active provider-test tenants, cases, artifacts, objects,
and temporary restore schemas are cleaned after each run. Provider resource
identifiers and credentials are deliberately omitted from committed evidence.

## Repository source handling

The development-verified repository path accepts a server-authorized GitHub
repository ID and exact commit, never a pasted URL or source body. For public
source, no GitHub credential is minted. For the implemented private path, a
short-lived installation credential is scoped to the exact trusted-host API
request and is neither forwarded to the temporary archive host nor placed in a
sandbox, environment, command, file, log, artifact, or bundle.

The trusted host buffers only a bounded compressed archive long enough to hash
and inject its bytes into a disposable sandbox. Raw repository source is not a
durable application artifact. The sandbox prepares the supported lock, runs
under deny-all, and is stopped; snapshots are deleted or quarantined for
operator cleanup. Durable evidence may retain sanitized command/output hashes,
bounded redacted output, immutable source provenance, and the resulting private
Repro Bundle under the documented retention policy.

Committed repository evidence comes only from the public synthetic canary and
has been scanned for the planted secret, credential names, provider resource
identifiers, local paths, and provider URLs. No private-repository provider test
or live user-consent/account flow is claimed yet; do not submit private or
customer code until those gates pass.

## Optional live investigator

Live mode is separate and explicit. When a caller selects `live` and configures `OPENAI_API_KEY`, the submitted repository metadata, issue text, and supplied evidence are sent to the OpenAI Responses API. ReproForge sets `store: false`, but use of that service remains subject to the applicable OpenAI terms and data controls.

Do not submit secrets, credentials, customer data, regulated data, or private
source content. The current product does not include a data-classification UI
or organization policy enforcement. Account export/deletion controls do not
change the separate live-investigator disclosure or make sensitive submissions
appropriate.

## Logs and bundles

The bundle builder can redact exact registered secret values from serialized artifacts. It does not discover every possible secret or personal identifier. Inputs should be sanitized before they reach the application, and generated bundles should be reviewed before sharing.

The application defines no first-party analytics or advertising integration. Hosting providers, browsers, proxies, and operators may produce their own infrastructure logs outside this repository's control.

## Evidence assets

Committed screenshots contain only the synthetic trusted sample and local application chrome, including the actual MCP App proof resource rendered by its preview harness. Evidence manifests document capture time, source commit, viewport, sanitization, and provenance. No screenshot is represented as a real ChatGPT-host session unless it was captured in that host.
