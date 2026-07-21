# ReproForge GitHub App setup contract

ReproForge uses a GitHub App as a trust domain separate from Auth0. The checked
manifest example at [`config/github-app-manifest.example.json`](../config/github-app-manifest.example.json)
is the reviewable registration contract; deployment tooling replaces only the
canonical example origin and development name.

## Permissions and events

- Repository metadata: read.
- Repository contents: read.
- Issues: read, because issue-number intake is enabled.
- No `default_events` are requested. GitHub automatically delivers the
  `installation` and `installation_repositories` lifecycle events to every
  GitHub App, and does not allow apps to subscribe to them explicitly.
- No repository write, Actions, secret, organization administration, or user
  account permission is requested.

The install flow requests GitHub App user authorization only during setup. The
returned user token is used transiently to prove that the signed-in installer
can access the callback's installation ID, then discarded. Reproduction uses
short-lived, repository-scoped installation tokens and never uses a user token.
This closes the spoofed-`installation_id` risk called out by GitHub's
[setup URL guidance](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-setup-url).

## Callback boundary

1. A signed-in ReproForge principal starts the install flow.
2. The server creates 256 bits of random state, stores only its SHA-256 hash,
   binds it to tenant and principal, and expires it after ten minutes.
3. GitHub returns the state, installation ID, and one-time authorization code.
4. The state is atomically consumed once before code exchange.
5. A transient GitHub user token proves installation access. The server stores
   installation metadata only.

GitHub documents the install-link `state` parameter in its
[GitHub App sharing guide](https://docs.github.com/en/apps/sharing-github-apps/sharing-your-github-app).

## Webhook boundary

The endpoint accepts only JSON `installation` and
`installation_repositories` deliveries. It verifies the raw request bytes with
`X-Hub-Signature-256`, performs a constant-time HMAC-SHA256 comparison, limits
payload size, and validates `X-GitHub-Delivery` before JSON parsing. The secret
is server-only and never committed. This follows GitHub's
[webhook validation guide](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries).
