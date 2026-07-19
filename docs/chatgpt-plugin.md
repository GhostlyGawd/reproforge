# ChatGPT app and plugin guide

ReproForge 0.2.0 implements the complete local trusted-sample app boundary: a
stateless Streamable HTTP MCP endpoint at `/mcp`, three narrow tools, and a
self-contained MCP App proof widget. ChatGPT users do not provide an OpenAI API
key. ChatGPT supplies the conversational host under the user's plan;
ReproForge supplies and ultimately pays for its own server, storage, and runner
capacity.

## What works now

| Boundary | Current state |
|---|---|
| MCP endpoint | Implemented at `POST /mcp`; stateless JSON responses; CORS preflight |
| `start_reproduction` | Runs only `cli-spaces`; caller-scoped and idempotent |
| `get_reproduction` | Reads a stable case/proof snapshot |
| `export_repro_bundle` | Returns only a machine-verified content-addressed bundle |
| Embedded widget | MCP Apps bridge, responsive layouts, closed CSP, no external assets |
| User OpenAI API key | Not accepted or required |
| Arbitrary repositories | Rejected; no tool input exists for a URL or command |
| Authentication | `noauth` for public synthetic data only |
| Persistence | Process-local memory only |
| Hosted ChatGPT app | Not created or claimed in this repository |
| Public plugin | Not submitted or published |

The no-auth endpoint is deliberately useful only for a fixed synthetic fixture.
Private or customer data requires the OAuth, tenant-isolation, persistence, and
sandbox work in Milestone 8.

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
| `start_reproduction` | Additive | stable idempotency key, fixed sample ID, bounded budget | case/job IDs, state, proof, evidence counts, hypotheses, sanitized runs |
| `get_reproduction` | Read-only | case ID | the same schema-versioned reproduction view |
| `export_repro_bundle` | Read-only | case ID | hash, schema version, status, and file names |

Every tool declares `openWorldHint: false`, `destructiveHint: false`, and an
accurate read/idempotency annotation. The tool schemas have
`additionalProperties: false`. Full bundle files are widget-only metadata on an
explicit export; they are not placed into model narration.

## Connect in ChatGPT developer mode

ChatGPT cannot reach `localhost`; it needs an HTTPS URL that forwards to this
server. A temporary development tunnel is acceptable for an account-side smoke
but is not a production deployment. Do not expose the endpoint with real data,
and do not treat a tunnel URL as stable hosting.

Once a reviewed HTTPS endpoint exists:

1. In ChatGPT, open **Settings → Security and login** and enable **Developer mode**.
2. Open **Settings → Plugins** (or the Plugins page), select the plus button,
   and create a developer-mode app using `https://<host>/mcp`.
3. Confirm ChatGPT discovers exactly the three documented tools and the
   `text/html;profile=mcp-app` resource.
4. Ask ReproForge to run its trusted CLI-spaces demonstration. Confirm the card
   shows `VERIFIED`, 3/3 candidate matches, and a clear control.
5. Repeat the same tool call with the same idempotency key; confirm the case and
   job IDs do not change.
6. Export the bundle and inspect its eight files.
7. Copy the new app ID from the ChatGPT browser URL. It begins with
   `plugin_asdk_app`.

The repository does not contain a fabricated app ID. When the real ID is
available, use the `plugin-creator` workflow to generate and validate a local
Codex plugin wrapper with `.codex-plugin/plugin.json` and `.app.json`. That
wrapper is for local plugin-directory testing; the public submission path is
different.

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
