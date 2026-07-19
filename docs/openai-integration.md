# GPT-5.6 investigator boundary

## Runtime modes

ReproForge deliberately separates the trusted sample from the optional live investigator.

The v2 REST service and planned ChatGPT/MCP adapter do not call the Responses API and do not accept a user OpenAI API key. In the subscription-first flow, ChatGPT chooses ReproForge MCP tools under the user's ChatGPT plan while ReproForge's deterministic server performs the work. This document describes only the separate optional standalone investigator.

| Mode | Selection | Credentials | Behavior |
| --- | --- | --- | --- |
| Trusted sample | UI button | None | Always uses the deterministic offline path and bundled fixture |
| Offline API | `mode: "offline"` or omitted | None | Returns the deterministic offline investigation plan |
| Live API | Explicit `mode: "live"` | `OPENAI_API_KEY` | Uses `gpt-5.6-sol` through the Responses API |

If live mode is explicitly requested without a key, `POST /api/investigate` returns HTTP 503. ReproForge never silently substitutes live inference for the trusted sample and never silently downgrades an explicit live request.

## Configure the optional live adapter

```bash
cp .env.example .env.local
```

Set `OPENAI_API_KEY` in `.env.local`, then restart the application. The OpenAI client is created lazily on the first explicit live request; importing the module, rendering the page, and exercising the offline path do not initialize a client or make a network request.

Example offline request:

```bash
curl http://localhost:3000/api/investigate \
  --header "Content-Type: application/json" \
  --data '{"mode":"offline","repository":"fixture://cli-spaces","issue":"The CLI fails when the config path contains spaces."}'
```

Change `mode` to `live` only when you intend to make an OpenAI API request.

## Responses request contract

Every live turn pins these choices:

- model: `gpt-5.6-sol`;
- reasoning effort: `medium`;
- text verbosity: `low`;
- response storage: disabled with `store: false`;
- tool choice: automatic but sequential with `parallel_tool_calls: false`;
- output budget: 1,800 tokens; and
- application tool-call budget: 1–12 calls, default 6.

The continuation loop appends the complete prior `response.output`—including reasoning items and function calls—before its validated `function_call_output` items. This follows the reasoning-model tool-continuation requirement without persisting a remote conversation.

## Permission and verification boundary

The model receives only three strict application tools:

1. `record_evidence` records a sourced `reported`, `observed`, `inferred`, or `unknown` item.
2. `record_hypothesis` records a falsifiable hypothesis linked to evidence that already exists.
3. `propose_experiment` selects either the `control` or `reproduce` trusted-fixture recipe.

All tool schemas require every declared property and set `additionalProperties: false`. There is no arbitrary command, filesystem mutation, credential, network, publication, or final-verdict tool. Tool outputs are validated again with Zod, duplicate identifiers are rejected, cross-references must resolve, and the loop fails closed when its budget is exceeded.

GPT-5.6 may organize evidence and propose an experiment. It cannot execute a command or decide that a reproduction is `VERIFIED`; the runner, oracle engine, negative control, repeat runs, and bundle validator retain those decisions in deterministic application code.

## Offline and recorded testing

- `OfflineInvestigator` provides the full no-key path and is property-tested for determinism and budget compliance over 150 generated inputs.
- `tests/fixtures/openai/investigation-turns.json` is a sanitized, recorded two-turn contract fixture.
- Contract tests assert the model, reasoning, storage, strict tools, permission surface, tool budget, and preservation of reasoning/function-call items.
- Live smoke testing is optional and is skipped when `OPENAI_API_KEY` is absent. Recorded fixtures are the required CI path.

## Official references

Contract choices were checked on 2026-07-19 against the official OpenAI material:

- [GPT-5.6 model guidance](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.6)
- [Function calling](https://developers.openai.com/api/docs/guides/function-calling)
- [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- [Reasoning models](https://developers.openai.com/api/docs/guides/reasoning)
- [Responses API reference](https://platform.openai.com/docs/api-reference/responses)
