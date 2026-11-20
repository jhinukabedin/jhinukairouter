# Architecture — Jhinuk AI Router

Private multi-user AI Gateway + Smart Model Routing. One small Fastify
process; no microservices (CONTRACT refinement 4: SIMPLE + LIGHTWEIGHT).

## Runtime layout

```
Internet / OpenCode / Claude Code
        │  https://router.developersbd.top
        ▼
Nginx (BHPanel-managed, AutoSSL) ──► Node 24 Fastify API (PORT 3001, one process)
        │                                   │
        │                              ┌────┴─────────────────────────┐
        │                              │ PostgreSQL 16 (Prisma)       │
        │                              │ Redis 7 — OPTIONAL           │
        │                              │ (in-memory fallback if unset)│
        │                              └──────────────────────────────┘
        └─► Static dashboard (apps/web build) served by Nginx
```

Production decision (ONE clear path, per CONTRACT): the API is a single
Node process on `PORT` (default 3001). The dashboard is a static Vite build
served by Nginx from the same host (`/`), proxying `/api/*` and `/v1/*` to
the API. The API does **not** serve the dashboard itself — this keeps the
API process small and lets BHPanel/Nginx own TLS + static files.

## Repository layout

| Path | Owner | Notes |
| --- | --- | --- |
| `apps/api` | Agent 1 (+2/3 modules) | Fastify, auth, admin, health; gateway (Agent 2); routing/billing (Agent 3) |
| `apps/web` | Agent 4 | React + TS + Tailwind dashboard |
| `apps/worker` | Agent 3 | Optional; in-process stub only in Phase 1 |
| `packages/shared` | Agent 1 | TaskCategory, RoutingMode, NormalizedChat*, default task mapping, ordered chains |
| `packages/config` | Agent 1 | Zod env validation (REDIS_URL optional) |
| `packages/provider-sdk` | Agent 2 | Provider adapters (openai/anthropic/gemini/…) |
| `packages/protocols` | Agent 2 | OpenAI/Anthropic protocol helpers |
| `prisma/` | Agent 1 | Lean schema + migrations |

## Request flows

### Dashboard session (human)
`POST /api/v1/auth/login` → opaque session token (SHA-256 stored in
`UserSession`, 30-day expiry) → `Authorization: Bearer <token>` on
`/api/v1/*`. Sessions are revocable per-device (`GET/DELETE /api/v1/auth/sessions`).

### Gateway (Agent 2, `/v1/*`)
`Authorization: Bearer rk_live_…` → ApiKey SHA-256 lookup → routing profile
(task mapping = ordered model chains) → provider adapter → stream back.
Fallback only on 429/5xx/timeout/unavailable, respecting Retry-After, never
after the first streamed chunk, never double-billing (usage recorded once,
on final outcome). RTK-style token saving happens **inside** the gateway
(prompt/context compression, noisy-output trimming, idempotency, context
budget checks) — no second proxy between OpenCode and the router.

### Fallback chains (per-agent multi-model)
Each task/agent alias (coordinator, fast, coder, developer, reasoner,
architect) holds an **ordered list** of `{provider, model}` in
`RoutingProfile.taskMapping` (JSON) — e.g. Coordinator: Luna → DeepSeek
Flash → Kimi. See `packages/shared/src/index.ts`.

## Key design choices

- **Redis optional**: `REDIS_URL` empty/missing → in-memory rate limiting and
  in-process queue stubs. The router starts and serves `/v1` with API + DB only.
- **Health without dependencies**: `GET /health` never touches DB/Redis;
  `GET /health/ready` pings the DB (503 when down).
- **Per-user isolation**: every query filters by `userId`/`ownerId`; API keys
  are scoped to their owner; admins see all users, users see only their own.
- **Secrets**: Argon2id passwords; AES-256-GCM provider credentials
  (`ENCRYPTION_MASTER_KEY`, never in DB); SHA-256 router API keys, shown once.
- **Single-process worker**: BullMQ/Redis only if actually needed later;
  Phase 1 health checks / usage aggregation run in-process.

## What was deliberately left out (light version)

- No separate auth service, gateway service, or worker service.
- No Redis-backed rate limiting / queue in Phase 1 (in-memory + in-process).
- No email sending yet (password-reset tokens are created; SMTP wiring is
  Phase 2 — see `docs/IMPLEMENTATION_STATUS.md`).
- No Prometheus/Grafana; monitoring is `GET /health`, `/health/ready`, and
  structured logs (Phase 7 light version).
