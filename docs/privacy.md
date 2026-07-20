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
These controls are implemented, but no public account deletion endpoint or
retention-administration UI exists yet.

Current live provider evidence uses only generated synthetic identifiers and
the bundled fixture. Active provider-test tenants, cases, artifacts, objects,
and temporary restore schemas are cleaned after each run. Provider resource
identifiers and credentials are deliberately omitted from committed evidence.

## Optional live investigator

Live mode is separate and explicit. When a caller selects `live` and configures `OPENAI_API_KEY`, the submitted repository metadata, issue text, and supplied evidence are sent to the OpenAI Responses API. ReproForge sets `store: false`, but use of that service remains subject to the applicable OpenAI terms and data controls.

Do not submit secrets, credentials, customer data, regulated data, or private
source content. The current product does not include a data-classification UI,
consent workflow, public deletion endpoint, or organization policy enforcement.

## Logs and bundles

The bundle builder can redact exact registered secret values from serialized artifacts. It does not discover every possible secret or personal identifier. Inputs should be sanitized before they reach the application, and generated bundles should be reviewed before sharing.

The application defines no first-party analytics or advertising integration. Hosting providers, browsers, proxies, and operators may produce their own infrastructure logs outside this repository's control.

## Evidence assets

Committed screenshots contain only the synthetic trusted sample and local application chrome, including the actual MCP App proof resource rendered by its preview harness. Evidence manifests document capture time, source commit, viewport, sanitization, and provenance. No screenshot is represented as a real ChatGPT-host session unless it was captured in that host.
