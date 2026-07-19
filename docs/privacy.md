# Privacy behavior

## Offline trusted sample

The default sample uses synthetic issue text and a bundled fixture. It requires no account, API key, telemetry service, database, or third-party request. REST v2 case/job state is held in memory for one server process and disappears on restart. A downloaded bundle is written only where the browser user chooses to save it.

## Optional live investigator

Live mode is separate and explicit. When a caller selects `live` and configures `OPENAI_API_KEY`, the submitted repository metadata, issue text, and supplied evidence are sent to the OpenAI Responses API. ReproForge sets `store: false`, but use of that service remains subject to the applicable OpenAI terms and data controls.

Do not submit secrets, credentials, customer data, regulated data, or private source content. The MVP does not include a data-classification UI, consent workflow, retention administration, deletion endpoint, or organization policy enforcement.

## Logs and bundles

The bundle builder can redact exact registered secret values from serialized artifacts. It does not discover every possible secret or personal identifier. Inputs should be sanitized before they reach the application, and generated bundles should be reviewed before sharing.

The application defines no first-party analytics or advertising integration. Hosting providers, browsers, proxies, and operators may produce their own infrastructure logs outside this repository's control.

## Evidence assets

Committed screenshots contain only the synthetic trusted sample and local application chrome. Evidence manifests document capture time, source commit, viewport, sanitization, and provenance.
