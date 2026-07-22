# ChatGPT app and plugin guide

ReproForge 0.2.0 implements the complete local trusted-sample app boundary: a
stateless Streamable HTTP MCP endpoint at `/mcp`, five narrow tools, and a
self-contained MCP App proof widget. ChatGPT users do not provide an OpenAI API
key. ChatGPT supplies the conversational host under the user's plan;
ReproForge supplies and ultimately pays for its own server, storage, and runner
capacity.

## What works now

| Boundary | Current state |
|---|---|
| MCP endpoint | Implemented at `POST /mcp`; stateless JSON responses; CORS preflight |
| `start_reproduction` | Runs keyless `cli-spaces`, or accepts only a server-authorized repository ID plus immutable SHA under OAuth; caller-scoped and idempotent |
| `list_authorized_repositories` | OAuth-protected, read-only list from the caller's active GitHub App installation |
| `get_reproduction` | Reads a stable case/proof snapshot |
| `cancel_reproduction` | OAuth-protected, idempotent cancellation request for active repository work |
| `export_repro_bundle` | Returns only a machine-verified content-addressed bundle |
| Embedded widget | MCP Apps bridge, responsive layouts, closed CSP, no external assets |
| User OpenAI API key | Not accepted or required |
| Arbitrary repositories | Rejected; no tool input exists for a URL, branch, source body, or command |
| Authentication | `noauth` for the public synthetic fixture; production Auth0/GitHub evidence for the web path; protected ChatGPT OAuth review still pending |
| Persistence | Local memory by default; provider-verified Neon/Blob/Queue composition for fully configured hosted modes |
| Hosted ChatGPT app | Connected in developer mode at the production MCP URL; anonymous trusted prompt/widget/export passed |
| Public plugin | Not submitted or published |

The no-auth endpoint is deliberately useful only for a fixed synthetic fixture.
Durable storage does not authorize data. The isolated runner, production
account/install flow, and public canary have direct evidence, but private or
customer use still requires private-canary, revocation, protected ChatGPT, and
private-beta evidence.

## Run and inspect locally

Install dependencies and start the application:

```bash
npm ci
npm run dev
```

- MCP endpoint: `http://127.0.0.1:3000/mcp`
- standalone widget preview: `http://127.0.0.1:3000/widget-preview`
- deterministic protocol smoke: `npm run mcp:smoke`

The smoke starts and retries the fixture, reads the case, exports the bundle,
and prints a sanitized JSON contract. It temporarily removes
`OPENAI_API_KEY`, so a passing result proves the app path is keyless.

Use the official MCP Inspector CLI against the running server:

```bash
npx -y @modelcontextprotocol/inspector@latest --cli \
  http://127.0.0.1:3000/mcp \
  --transport http \
  --method tools/list
```

The interactive Inspector also supports the Streamable HTTP URL. Start it with
`npx -y @modelcontextprotocol/inspector@latest`, select Streamable HTTP, and
enter the endpoint above. Keep the Inspector bound to localhost; its proxy is a
development tool, not a service to expose publicly.

## Tool contract

| Tool | Mutation | Inputs | Model-visible result |
|---|---|---|---|
| `start_reproduction` | Additive | stable idempotency key, strict trusted-sample or authorized-repository source, bounded budget/profile/oracle | case/job IDs, state, proof, evidence counts, hypotheses, sanitized runs |
| `list_authorized_repositories` | Read-only | bounded cursor/limit | authorized repository IDs and non-secret metadata |
| `get_reproduction` | Read-only | case ID | the same schema-versioned reproduction view |
| `cancel_reproduction` | Destructive, idempotent | job ID | sanitized cancellation state |
| `export_repro_bundle` | Read-only | case ID | hash, schema version, status, and file names |

Every tool declares `openWorldHint: false` and accurate destructive,
read-only, and idempotency annotations. Only cancellation has
`destructiveHint: true`. The tool schemas have
`additionalProperties: false`. Full bundle files are widget-only metadata on an
explicit export; they are not placed into model narration.

## Connect in ChatGPT developer mode

ChatGPT cannot reach `localhost`; it needs HTTPS. The current developer-mode
app uses the stable review endpoint `https://reproforge.vercel.app/mcp`. For a
different environment, a temporary development tunnel is acceptable only for
an account-side smoke. Do not expose real data through an unreviewed tunnel.

To recreate or refresh the reviewed connection:

1. In ChatGPT, open **Settings → Security and login** and enable **Developer mode**.
2. Open **Settings → Plugins** (or the Plugins page), select the plus button,
   and create a developer-mode app using `https://<host>/mcp`.
3. Confirm ChatGPT discovers exactly the five documented tools and the
   `text/html;profile=mcp-app` resource.
4. Ask ReproForge to run its trusted CLI-spaces demonstration. Confirm the card
   shows `VERIFIED`, 3/3 candidate matches, and a clear control.
5. Repeat the same tool call with the same idempotency key; confirm the case and
   job IDs do not change.
6. Export the bundle and inspect its eight files.
7. Record the app and version IDs from the developer-mode connection details.
   Current IDs use the `asdk_app_` and `asdk_app_v_` prefixes.

The real app/version IDs are recorded in the sanitized host evidence. The
repository-local Codex wrapper under `plugins/reproforge` is validated against
that evidence and is packaging only; it is not a substitute for either the
connected ChatGPT app or the public submission path.

## Public plugin path

Public submission scans the production MCP server directly rather than reusing
the developer-mode app reference. Milestone 9 requires stable HTTPS, publisher
and domain verification, privacy/terms/support URLs, a final logo and listing,
five positive and three negative review cases, security/load/accessibility
evidence, rollback readiness, and explicit go/no-go approval. No submission or
publication is authorized by the source implementation alone.

## Official references

- [Build an app](https://learn.chatgpt.com/docs/build-app)
- [Build plugins](https://learn.chatgpt.com/docs/build-plugins)
- [Submit plugins](https://learn.chatgpt.com/docs/submit-plugins)
- [MCP Inspector](https://modelcontextprotocol.io/docs/tools/inspector)
- [MCP TypeScript server guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/server.md)
