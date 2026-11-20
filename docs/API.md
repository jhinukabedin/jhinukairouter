# API Reference — Jhinuk AI Router

> **Gateway section (`/v1/*`) is Builder 2's** — see
> **"Gateway (`/v1/*`) — Builder 2"** at the end of this file. This file
> currently documents the **dashboard API (`/api/v1/*`)** maintained by
> Builder 4 (frontend).

Base URL (dashboard API): same origin as the dashboard in production
(`https://router.developersbd.top/api/v1`), or `http://localhost:3001/api/v1`
in local dev. The Vite dev server proxies `/api` and `/v1` to `localhost:3001`.

Auth for dashboard calls: `Authorization: Bearer <session-token>` (issued by
`/api/v1/auth/login`, stored in `sessionStorage` only). Gateway calls use a
router API key instead — see `docs/CLIENT_INTEGRATION.md`.

All responses are JSON. Errors: `{ "message": "..." }` with the HTTP status.
Provider credentials and full router keys are **never** returned by any endpoint
below — keys are shown once, at creation/regeneration, and only the prefix is
stored visibly afterwards.

## Auth — `POST /api/v1/auth/*`

| Method & path | Body | Notes |
|---|---|---|
| `POST /api/v1/auth/register` | `{ email, password, name? }` | Returns `{ user, token }`. May be disabled (`REGISTRATION_ENABLED=false`). |
| `POST /api/v1/auth/login` | `{ email, password, totpCode? }` | Returns `{ user, token }`. |
| `POST /api/v1/auth/logout` | — | Revokes the current session. |
| `POST /api/v1/auth/password-reset/request` | `{ email }` | Sends a reset token (if the account exists). |
| `POST /api/v1/auth/password-reset/confirm` | `{ token, password }` | Sets the new password. |
| `GET /api/v1/auth/sessions` | — | Active sessions for the current user. |
| `DELETE /api/v1/auth/sessions/:id` | — | Revoke one session. |
| `POST /api/v1/auth/totp/setup` | — | Returns `{ secret, qrUrl? }` — secret shown once. |
| `POST /api/v1/auth/totp/verify` | `{ code }` | Verifies a TOTP code. |

## Users — `GET /api/v1/users/me`

Returns the current user `{ id, email, name, status, createdAt }`.

## Providers — `/api/v1/providers` (Builder 2 owns the server side)

| Method & path | Notes |
|---|---|
| `GET /api/v1/providers` | List providers (global + own). |
| `POST /api/v1/providers` | Create. Body: `{ name, type, baseUrl, protocol, apiKey?, enabled?, priority?, timeoutMs? }`. `apiKey` is stored encrypted, never returned. |
| `PATCH /api/v1/providers/:id` | Update (same fields; `apiKey` rotates the stored credential). |
| `DELETE /api/v1/providers/:id` | Delete. |
| `POST /api/v1/providers/:id/test` | Test connection. Returns `{ ok, latencyMs?, error? }`. |
| `POST /api/v1/providers/:id/sync-models` | Sync models from the provider. Returns `{ synced, models }`. New models appear in Routing Profiles pickers and `GET /v1/models` immediately. |

Provider `type`: `openai | anthropic | gemini | deepseek | moonshot | glm | openrouter | tokens | ollama | custom`.
`protocol`: `openai | anthropic`. Custom `baseUrl` values pointing at localhost /
private IPs are rejected unless an admin sets `allowLocalProviders=true`.

## Models — `/api/v1/models`

| Method & path | Notes |
|---|---|
| `GET /api/v1/models` | List models with provider + pricing. |
| `POST /api/v1/models` | Create. Body: `{ providerId, modelId, displayName?, contextWindow?, maxOutputTokens?, supportsStreaming?, supportsTools?, supportsVision?, supportsReasoning?, enabled?, inputPricePer1M?, outputPricePer1M?, currency? }`. |
| `PATCH /api/v1/models/:id` | Update (incl. `enabled`, `pricing`). |

## API keys — `/api/v1/api-keys`

| Method & path | Notes |
|---|---|
| `GET /api/v1/api-keys` | List — prefix only, never the full key. |
| `POST /api/v1/api-keys` | Create `{ name, expiresAt? }`. Returns the full key **once** in `key`. |
| `DELETE /api/v1/api-keys/:id` | Delete (revoke). |
| `POST /api/v1/api-keys/:id/regenerate` | New key, old one stops working. Full key returned **once**. |

## Routing profiles — `/api/v1/routing-profiles` (Builder 3 owns the server side)

| Method & path | Notes |
|---|---|
| `GET /api/v1/routing-profiles` | List profiles. |
| `POST /api/v1/routing-profiles` | Create `{ name, mode, taskMapping, isDefault?, budgetDailyCredits? }`. |
| `PATCH /api/v1/routing-profiles/:id` | Update. |
| `DELETE /api/v1/routing-profiles/:id` | Delete. |
| `POST /api/v1/routing-profiles/:id/rules` | Add a routing rule to a profile. |
| `GET /api/v1/fallback-rules` | List fallback rules. |
| `POST /api/v1/fallback-rules` | Create `{ profileId?, fromModelId?, toModelId, trigger, order }`. `trigger`: `429 \| 5XX \| TIMEOUT \| UNAVAILABLE`. |
| `DELETE /api/v1/fallback-rules/:id` | Delete. |

**`taskMapping` shape (per-agent multi-model chains):** values are ordered
arrays of `{ provider, model }` — e.g.
`"GENERAL": [{ "provider": "tokens", "model": "gpt-6-luna" }, { "provider": "deepseek", "model": "deepseek-flash" }]`.
A plain string value (`"tokens/gpt-6-luna"`) is accepted and treated as a
single-entry chain. `mode`: `AUTOMATIC | MANUAL | HYBRID`.

**Dashboard test calls:** the Routing Profiles page tests a chain entry with a
tiny `POST /v1/chat/completions` through the dashboard session; the response
reports which model actually served the request.

## Usage & billing — `/api/v1/usage`, `/api/v1/credits` (Builder 3 owns the server side)

| Method & path | Notes |
|---|---|
| `GET /api/v1/usage/summary?from&to&model&provider` | Totals: `totalRequests, routedRequests, inputTokens, outputTokens, cachedTokens, tokensSaved, estimatedCost, platformCharge, errorRate, avgLatencyMs`, plus `byUser, byApiKey, byModel, byProvider, daily[]`. Admins see all users; users see only their own (enforced server-side). |
| `GET /api/v1/usage?page&limit&from&to&model&provider&status` | Paginated request history (`{ data, total, page, limit }`). Never includes raw prompts. |
| `GET /api/v1/credits` | Current wallet `{ balance, currency }`. |
| `GET /api/v1/credits/transactions?page&limit` | Immutable ledger (`PURCHASE | DEBIT | REFUND | ADJUSTMENT`). |
| `POST /api/v1/credits/adjust` | Admin only. `{ userId, amount, description? }`. |

The dashboard Usage / Hiseb page renders **only** what these endpoints return
— no mock or sample numbers anywhere in the UI. CSV export is built client-side
from the fetched rows.

## Admin — `/api/v1/admin/*` (Builder 1 owns the server side)

| Method & path | Notes |
|---|---|
| `GET /api/v1/admin/users` | List users (+ roles). Admin only. |
| `POST /api/v1/admin/users` | Create user `{ email, password, name?, roles? }`. |
| `PATCH /api/v1/admin/users/:id` | Update user / roles. |
| `POST /api/v1/admin/users/:id/suspend` | Suspend. |
| `POST /api/v1/admin/users/:id/activate` | Activate. |
| `GET /api/v1/admin/audit-logs?page&limit` | Audit log. |
| `GET /api/v1/admin/system-settings` | List settings `{ key, value }`. |
| `PATCH /api/v1/admin/system-settings` | Update one setting `{ key, value }`. Known key: `allowLocalProviders`. |
| `GET /api/v1/admin/provider-health` | Per-provider health `{ providerId, status, lastLatencyMs, lastErrorRate, consecutiveFailures, ... }`. |

## Health

| Method & path | Notes |
|---|---|
| `GET /health` | Answers without DB/Redis. `{ status, uptimeSec?, db?, redis? }`. |
| `GET /health/ready` | Readiness (DB/Redis checks). |

## Dashboard pages → endpoints

| Page | Endpoints used |
|---|---|
| Login / Register | `POST /api/v1/auth/login`, `POST /api/v1/auth/register` |
| Overview | `GET /api/v1/usage/summary`, `GET /api/v1/credits`, `GET /health`, `GET /api/v1/usage` |
| Providers | `GET/POST/PATCH/DELETE /api/v1/providers`, `POST /:id/test`, `POST /:id/sync-models` |
| Models | `GET /api/v1/models`, `POST /api/v1/models`, `PATCH /api/v1/models/:id` |
| API Keys | `GET/POST/DELETE /api/v1/api-keys`, `POST /:id/regenerate` |
| Routing Profiles | `GET/POST/PATCH/DELETE /api/v1/routing-profiles`, `GET/POST/DELETE /api/v1/fallback-rules`, `GET /api/v1/models`, `POST /v1/chat/completions` (test) |
| Usage / Hiseb | `GET /api/v1/usage/summary`, `GET /api/v1/usage` |
| Credits | `GET /api/v1/credits`, `GET /api/v1/credits/transactions`, `POST /api/v1/credits/adjust` |
| Request Logs | `GET /api/v1/usage` |
| Client Setup | `GET /v1/models` (connection test, with a user-supplied router key) |
| Settings | `GET /api/v1/users/me`, `GET/DELETE /api/v1/auth/sessions`, `POST /api/v1/auth/totp/*` |
| Admin | `GET/POST/PATCH /api/v1/admin/users`, `POST /:id/suspend|activate`, `GET /api/v1/admin/audit-logs`, `GET/PATCH /api/v1/admin/system-settings`, `GET /health`, `GET /api/v1/admin/provider-health` |

---

## Gateway (`/v1/*`) — Builder 2

Base URL (production): `https://router.developersbd.top`
Local dev: `http://localhost:3001`

All gateway routes live under `/v1` and speak OpenAI-compatible (and
Anthropic-compatible) wire formats, so existing OpenCode / Claude Code /
VS Code clients work by only changing `base_url` / `api_key`.

### Authentication (gateway)

```
Authorization: Bearer <router-api-key>
```

Router API keys are created in the dashboard (`ApiKey`, stored as SHA-256
`keyHash`, shown once). The gateway looks the key up by hash; an unknown,
expired or revoked key gets `401 { error: { code: "unauthorized" } }`.
Provider credentials are never sent to the frontend and never appear in
gateway responses or logs.

Per-key rate limit (in-memory, default 120 requests / 60 s per key):
exceeding it returns `429` with a `Retry-After` header.

### POST /v1/chat/completions

OpenAI-compatible chat. Non-streaming returns a `chat.completion` object;
with `"stream": true` it returns SSE `chat.completion.chunk` events ending
in `data: [DONE]`.

Request (subset — full OpenAI fields pass through):

```jsonc
{
  "model": "gpt-6-luna",           // or "tokens/gpt-6-luna" (provider/model)
  "messages": [{ "role": "user", "content": "Hello" }],
  "tools": [/* OpenAI function tools */],
  "temperature": 0.7,
  "max_tokens": 1024,
  "stream": false,
  "rtk": true,                     // RTK optimisation toggle, default true
  "idempotencyKey": "unique-key"   // optional; also via Idempotency-Key header
}
```

Response `usage` carries an extra field:

```jsonc
"usage": {
  "prompt_tokens": 12,
  "completion_tokens": 8,
  "total_tokens": 20,
  "tokens_saved": 134   // estimated tokens saved by RTK optimisation
}
```

#### Fallback (per-agent multi-model chains)

Each task/agent maps to an ORDERED list of `(provider, model)` pairs
(e.g. Coordinator: Luna → DeepSeek Flash → Kimi). On `429` / `5xx` /
timeout / unavailable the gateway tries the next entry, respecting the
upstream `Retry-After` header (capped at 5 s). It NEVER retries `401` /
`400`, and NEVER switches model after the first streamed chunk. Usage is
recorded exactly once per request, for the model that actually served it,
with the full `attemptedChain` in the usage record.

#### RTK optimisation (inside the gateway — NOT a proxy)

Applied by default (`rtk: true`, or `"optimize": true`); set `"rtk": false`
to disable per request. Steps, in order:

1. Trim duplicate whitespace; drop empty messages.
2. Trim noisy tool outputs (cap 4000 chars, collapse repeated lines).
3. Truncate oldest non-system history over the model's context budget
   (system messages and the latest user message are always kept).
4. Prompt caching is passed through where the provider supports it.
5. Duplicate requests are prevented via idempotency key (replay, no
   second provider call, no second charge).

`tokensSaved` is recorded per request in the usage record and shown on the
dashboard. Jhinuk's local RTK OpenCode plugin on his PC and this router
must NOT both proxy the same request: the plugin uses the router as its
base URL (`https://router.developersbd.top/v1`); the router optimises once,
server-side. Do not put a second proxy between OpenCode and Tokens.

### GET /v1/models

OpenAI-format list of enabled models (added via Add Provider / Sync
Models — a new model appears here immediately, no redeploy):

```jsonc
{ "object": "list", "data": [{ "id": "gpt-6-luna", "object": "model", "owned_by": "tokens" }] }
```

### POST /v1/embeddings

OpenAI-compatible embeddings passthrough:

```jsonc
{ "model": "text-embedding-3-small", "input": "hello" }
```

Returns the provider's response unchanged. The model is resolved through
the same chain as chat (first entry only — no fallback for embeddings).

### POST /v1/responses

OpenAI Responses API. `input` may be a string or an array of
`{role, content}` items; `instructions` becomes a system message.
Non-streaming returns a `response` object; `"stream": true` returns
`response.created` / `response.output_text.delta` / `response.completed`
SSE events. `usage` also carries `tokens_saved`.

### POST /v1/messages

Anthropic Messages API. Accepts `system`, `messages` (text, `tool_use`
and `tool_result` blocks), `tools` (`input_schema` form) and `max_tokens`.
Returns an Anthropic `message` object (`stop_reason: end_turn` or
`tool_use`); `"stream": true` returns Anthropic SSE events
(`message_start`, `content_block_delta`, `message_delta`, `message_stop`).
Tool calls are translated to OpenAI-style `tool_calls` internally and are
returned to the caller — the gateway never executes client tools.

### Gateway errors

All errors use `{ "error": { "message", "type", "code" } }`:

| Status | Code | Meaning |
|--------|------|---------|
| 400 | `invalid_request` | bad body / validation failed |
| 401 | `unauthorized` / `provider_auth_failed` | bad router key / bad provider key (no retry) |
| 404 | `model_not_found` | model unknown or disabled |
| 408 | `timeout` | provider timed out (retryable for fallback) |
| 409 | `duplicate_request` | idempotency key already in flight |
| 429 | `rate_limited` | upstream 429 or per-key gateway limit |
| 502 | `provider_error` | upstream 5xx / unreachable |
| 503 | `unavailable` | no provider in the chain could serve |

### Providers API — server-side notes (Builder 2)

Auth for `/api/v1/providers` and `/api/v1/models` is Builder 1's
session/role guard, plugged in as an `authenticate` hook; without it the
routes are open (dev/test only). `credential` and `apiKey` are accepted
interchangeably as the write-only provider key field. Responses use a
`{ data: ... }` envelope. Provider types: `openai`, `anthropic`, `gemini`,
`deepseek`, `moonshot` (Kimi), `glm`, `openrouter`, `tokens` (base
`https://tokens.bd/v1`), `ollama` (default `http://localhost:11434/v1`),
`custom` (OpenAI- or Anthropic-compatible, `baseUrl` required, `protocol`
selects the wire format).

SSRF guard: custom `baseUrl` must be `http(s)` with no embedded
credentials and must not point at localhost / `127.x` / `10.x` /
`172.16–31.x` / `192.168.x` / `169.254.x` unless the admin setting
`allowLocalProviders=true` is set. Ollama is local-only and always
requires that setting.
