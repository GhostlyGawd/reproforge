# Auth0 setup for ChatGPT OAuth

ReproForge uses Auth0 as an OAuth 2.1 authorization server. ChatGPT is the
OAuth client and ReproForge is the protected resource. This path uses the
user's ChatGPT subscription and never asks the user for an OpenAI API key.

## Required tenant configuration

Use a dedicated development or production tenant and configure all of the
following before treating the deployment as ChatGPT-compatible:

1. Create a regular web application for the ReproForge browser session. Allow
   `<origin>/auth/callback` as a callback, `<origin>` as a logout URL and web
   origin, and authorization-code plus refresh-token grants. Set both the
   application's **Application Login URI** and the tenant's **Default Login
   Route** to `<origin>/auth/login?returnTo=%2Frepositories`. This recovers a
   direct or stale Universal Login visit by starting a fresh application-owned
   authorization transaction instead of showing Auth0's generic error page.
2. Create an RS256 API whose identifier exactly equals `<origin>/mcp`. Define
   the five ReproForge scopes documented in
   [the ChatGPT guide](chatgpt-plugin.md).
3. Enable **Resource Parameter Compatibility Profile** and **Include Issuer in
   Authorization Responses**. ChatGPT sends the RFC 8707 `resource` parameter;
   Auth0 must copy that value into the access-token audience.
4. Enable **Dynamic Client Registration (DCR)**. ReproForge uses DCR for the
   initial private-beta connector. Auth0 must advertise its registration
   endpoint and allow public clients using authorization code + S256 PKCE with
   token endpoint authentication method `none`.
5. Create a default client grant for `third_party_clients`, the ReproForge API
   audience, all five scopes, and `subject_type: user`. DCR applications are
   third-party applications and cannot receive API access without this grant.
6. Promote the chosen database or social login connection to domain level.
   Dynamically registered third-party applications cannot use an ordinary
   application-only connection. Enable or disable first-party application
   connections through Auth0's dedicated
   `PATCH /api/v2/connections/{id}/clients` endpoint. Do not expose a social
   connection backed only by Auth0 development keys in production; configure
   provider-owned credentials first or leave that connection disabled.
7. Add a post-login Action that writes the same stable, namespaced tenant ID to
   the ID token and access token at
   `https://reproforge.vercel.app/tenant_id`. The value is derived from the
   authenticated Auth0 user ID and contains no email address or credential.

Client ID Metadata Documents (CIMD) can replace DCR after the ChatGPT connector
provides its deployment-specific CIMD URL. Until that client has been imported
and granted access, DCR remains the repeatable bootstrap path.

## Hosted environment

Set these encrypted values in each hosted environment. Preview and production
must use their own base URL and matching API audience.

```text
AUTH0_DOMAIN
AUTH0_CLIENT_ID
AUTH0_CLIENT_SECRET
AUTH0_SECRET
REPROFORGE_BASE_URL
REPROFORGE_OAUTH_TENANT_CLAIM
```

`AUTH0_SECRET` is a high-entropy cookie-encryption secret. Never commit or print
any of the first four values. `AUTH0_DOMAIN` is stored without a scheme;
`REPROFORGE_BASE_URL` is a canonical HTTPS origin with a trailing slash.

## Compatibility gate

After deployment, verify the public protected-resource document and Auth0
discovery document from the exact deployed commit:

```bash
npm run verify:hosted-oauth -- \
  --base-url https://reproforge.vercel.app/ \
  --authorization-server https://YOUR_TENANT.us.auth0.com/ \
  --commit COMMIT_SHA
```

The command fails unless the resource, issuer, same-origin authorization
endpoints, authorization-code response, S256 PKCE, supported token
authentication, and CIMD-or-DCR registration contracts all pass. It emits only
public metadata and is safe to retain as sanitized evidence.

## Required live proof

Configuration alone is not completion. The release gate also requires:

- a real browser login that provisions the ReproForge principal;
- an OAuth linking challenge and protected read through MCP Inspector;
- the same protected read through ChatGPT developer mode;
- a token whose issuer, audience, expiry, tenant claim, and scopes verify; and
- reauthorization, revocation, and signing-key refresh checks.

See [Milestone 8B](specs/milestone-8b-identity-and-github.md) and the
[hosted-launch specification](specs/milestone-9-hosted-launch.md) for the full
evidence gate.
