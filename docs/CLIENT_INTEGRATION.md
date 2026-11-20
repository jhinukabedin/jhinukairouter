# Client Integration — Jhinuk AI Router

Connect any OpenAI- or Anthropic-compatible client to the router. The router is the
single endpoint; providers, models, routing chains and billing live behind it.

- **Production base URL:** `https://router.developersbd.top/v1`
- **Local dev base URL:** `http://localhost:3001/v1`
- **Dashboard:** `https://router.developersbd.top/` (production)
- **Auth:** `Authorization: Bearer <router-api-key>` — create a key in the dashboard
  (API Keys page). A key is shown **once only**, at creation/regeneration. It is never
  displayed again, never stored in the dashboard, and never logged.

## Router aliases — the core idea

A router alias is a **multi-model fallback chain**, not a single model. The dashboard
page **Routing Profiles** holds one ordered chain per agent/task, e.g.:

| Alias (model id) | Agent / task | Default chain |
|---|---|---|
| `coordinator` | Coordinator (primary) | Luna → DeepSeek Flash → Kimi K2.7 Code |
| `fast` | Fast (quick answers) | Gemini Flash → Luna → DeepSeek Flash |
| `coder` | Coder (new code) | Kimi K2.7 Code → DeepSeek V4 Pro → Luna |
| `developer` | Developer (hard debugging) | DeepSeek V4 Pro → Kimi K2.7 Code → GLM-5.3 |
| `reasoner` | Reasoner | DeepSeek V4 Pro → GLM-5.3 → Luna |
| `architect` | Architect (design) | GLM-5.3 → Kimi K2.7 Code → DeepSeek V4 Pro |
| `general`, `code`, `reasoning` | Task aliases | Same chains as the matching task category |

Edit a chain once in Routing Profiles and **every client using that alias picks it up**
— no client config change. You can also use a concrete id, e.g.
`tokens/gpt-6-luna` or `moonshot/kimi-k2.7-code`. Concrete ids bypass the chain.
`GET /v1/models` lists aliases plus every enabled model.

Fallback rules: try #1; on 429 / 5xx / timeout / unavailable go to #2, then #3.
Retry-After is respected. 401/400 are never retried, and the model never switches
after the first streamed chunk. Usage is recorded once, on the final outcome —
never double-billed. The model that actually served a request is in the usage record
(Request Logs page) and in the `model` field of the response.

## OpenCode (recommended)

### Via the router (recommended)

`C:\Users\Jhinuk\.config\opencode\opencode.json` (or `~/.config/opencode/opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "router": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Jhinuk AI Router",
      "options": { "baseURL": "https://router.developersbd.top/v1" }
    }
  },
  "agent": {
    "coordinator": {
      "model": "router/coordinator",
      "prompt": "You are the coordinator. Plan, delegate to subagents, verify results."
    },
    "fast": { "model": "router/fast" },
    "coder": { "model": "router/coder" },
    "developer": { "model": "router/developer" },
    "reasoner": { "model": "router/reasoner" },
    "architect": { "model": "router/architect" }
  }
}
```

Set the API key as an environment variable before launching OpenCode:

```powershell
# Windows PowerShell
$env:ROUTER_API_KEY = "<your-router-api-key>"
opencode
```

```bash
# macOS / Linux
export ROUTER_API_KEY="<your-router-api-key>"
opencode
```

How the provider plugin reads the key depends on the OpenAI-compatible provider
package you use; if it expects `OPENAI_API_KEY`, set that instead and keep the
base URL pointed at the router. The key is a **router** key, not a provider key.

### RTK coexistence (important)

Your local RTK OpenCode plugin (`C:\Users\Jhinuk\.config\opencode\plugins\rtk.ts`)
**keeps working with the router as the base URL** — no change needed in RTK.
RTK hooks run inside OpenCode; the router is just the endpoint.

- **Do NOT add a proxy between OpenCode and the router.** RTK's proxy daemon was
  declined for a reason: RTK + router must not both proxy the same request.
- The router does RTK-style saving **inside the gateway**: safe prompt/context
  compression, noisy tool-output trimming, prompt caching where the provider
  supports it, duplicate-request prevention (idempotency), context-budget
  validation. No extra proxy layer.
- Per-request toggle: send `"rtk": true` (default ON for noisy output) or
  `"rtk": false` to disable gateway-side optimisation for one request.
- Tokens saved are recorded per request (`tokensSaved`) and shown on the
  Usage / Hiseb page — verify the saving there.
- If you ever see double trimming, turn RTK's trimming off in the plugin **or**
  set `rtk: false` on the request — never run both trims on the same text.

### Direct opencode.json — for non-router users

Same agents, concrete provider/model lists, no router:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "tokens": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Tokens",
      "options": { "baseURL": "https://tokens.bd/v1" }
    }
  },
  "agent": {
    "coordinator": {
      "model": "tokens/gpt-6-luna",
      "prompt": "You are the coordinator. Plan, delegate to subagents, verify results."
    },
    "fast": { "model": "tokens/gpt-6-luna" },
    "coder": { "model": "tokens/gpt-6-luna" },
    "developer": { "model": "tokens/gpt-6-luna" },
    "reasoner": { "model": "tokens/gpt-6-luna" },
    "architect": { "model": "tokens/gpt-6-luna" }
  }
}
```

(Replace the model ids with your own per-agent lists — e.g. coder on
Kimi, architect on GLM — if you run without the router.)

## Claude Code (Anthropic endpoint)

The router exposes `POST /v1/messages` (Anthropic-compatible). Point Claude Code
at the router:

```bash
export ANTHROPIC_BASE_URL="https://router.developersbd.top/v1"
export ANTHROPIC_API_KEY="<your-router-api-key>"   # router key, not an Anthropic key
export ANTHROPIC_MODEL="coordinator"               # router alias = multi-model chain
claude
```

The router translates Anthropic messages to the chain's first available model and
translates the response back. System prompts, tools and streaming work the same
way as the OpenAI path. `ANTHROPIC_MODEL` can be any alias or concrete
`provider/model` id.

## VS Code — Continue / Cline / Roo

All three accept an OpenAI-compatible provider. Example (Continue `config.yaml`):

```yaml
models:
  - name: Router — Coordinator
    provider: openai
    model: coordinator
    apiKey: <your-router-api-key>
    apiBase: https://router.developersbd.top/v1
  - name: Router — Coder
    provider: openai
    model: coder
    apiKey: <your-router-api-key>
    apiBase: https://router.developersbd.top/v1
```

In Cline / Roo Code, add a provider of type **OpenAI Compatible** with base URL
`https://router.developersbd.top/v1`, API key = your router key, model id = an
alias (`coordinator`, `coder`, …) or a concrete `provider/model` id.

## Aider

```bash
export OPENAI_API_BASE="https://router.developersbd.top/v1"
export OPENAI_API_KEY="<your-router-api-key>"
aider --model coordinator
# or: aider --model coder
```

## Generic OpenAI / Anthropic clients

Any client that speaks the OpenAI chat API works with the base URL + router key.
Anthropic-shaped clients use the same base URL with the `/v1/messages` endpoint.

### curl examples

```bash
# Chat completion (OpenAI shape)
curl https://router.developersbd.top/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <your-router-api-key>" \
  -d '{"model": "coordinator", "messages": [{"role": "user", "content": "Hello"}]}'

# Streaming
curl https://router.developersbd.top/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <your-router-api-key>" \
  -d '{"model": "coder", "stream": true, "messages": [{"role": "user", "content": "Write a hello-world in Python"}]}'

# List models (aliases + enabled models)
curl https://router.developersbd.top/v1/models \
  -H "Authorization: Bearer <your-router-api-key>"

# Anthropic shape
curl https://router.developersbd.top/v1/messages \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <your-router-api-key>" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model": "coordinator", "max_tokens": 256, "messages": [{"role": "user", "content": "Hello"}]}'

# Embeddings
curl https://router.developersbd.top/v1/embeddings \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <your-router-api-key>" \
  -d '{"model": "coordinator", "input": "hello world"}'
```

### Per-request fields the router understands

| Field | Meaning |
|---|---|
| `model` | Alias (`coordinator`, `coder`, …) or concrete `provider/model` id |
| `taskCategory` | Optional: `GENERAL`, `CODE_GENERATION`, `REASONING`, … — picks the matching task chain |
| `routingProfileId` | Optional: use a specific routing profile instead of your default |
| `rtk` | Optional boolean (default `true` for noisy output): gateway-side token saving |
| `idempotencyKey` | Optional: duplicate requests with the same key are not double-billed |

## Unsupported / not (yet) supported — honest list

- **No direct provider keys in clients is required** — but the router itself needs a
  provider key per provider (added once in the dashboard, stored encrypted).
- **No live analyser / tool execution on the server.** The router never executes
  client tools; tool calls are passed through to the model and back to the client.
- **No image generation, audio, or video endpoints** — chat, embeddings, responses
  and Anthropic messages only.
- **No offline mode.** The router needs network access to the providers.
- **Ollama is local-only** and only via an explicit admin config
  (`allowLocalProviders`); it is not reachable from the production host by default.
- **Vision** depends on the underlying model supporting it; the router does not
  add vision to a text-only model.
- **Prompt caching** applies only where the provider supports it; `cachedTokens`
  in usage shows what was actually cached.
- **Rate limits** are per router API key; provider-side 429s trigger fallback,
  they do not raise your key's limit.
- **Registration / email verification** follow the server settings
  (`REGISTRATION_ENABLED`, `REQUIRE_EMAIL_VERIFICATION`); the dashboard cannot
  override them.
