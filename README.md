# Jhinuk AI Router

Private multi-user AI Gateway + Smart Model Routing Platform.

- **API**: Node.js 24 + TypeScript (strict) + Fastify, one small process.
- **DB**: PostgreSQL + Prisma (lean schema, see `prisma/schema.prisma`).
- **Cache/queue**: Redis is **optional** — the router starts and serves `/v1` without it.
- **Web**: React + TS + Tailwind (apps/web, Agent 4).

> Status: foundation phase (Agent 1). See `docs/IMPLEMENTATION_STATUS.md`.
> Not deployed yet — deployment target is `https://router.developersbd.top`
> (BHPanel, Podman). See `docs/DEPLOYMENT.md`.

## Quick start (local dev)

```bash
cp .env.example .env   # fill in secrets (openssl rand -hex 32)
npm install
npx prisma generate
npx prisma migrate dev # needs Postgres; or use docker-compose
npm run dev             # API on http://localhost:3001
```

With Postgres (and optional Redis) via compose:

```bash
docker compose up -d db            # api runs locally against it
docker compose --profile redis up -d
```

## Layout

| Path | Owner | Contents |
| --- | --- | --- |
| `apps/api` | Agent 1 (+2/3 modules) | Fastify API, auth, admin, health |
| `apps/web` | Agent 4 | Dashboard (React) |
| `apps/worker` | Agent 3 | Optional in-process/BullMQ worker |
| `packages/shared` | Agent 1 | Shared types, task mapping, chain type |
| `packages/config` | Agent 1 | Zod env validation |
| `packages/provider-sdk` | Agent 2 | Provider adapters |
| `packages/protocols` | Agent 2 | OpenAI/Anthropic protocol helpers |
| `prisma/` | Agent 1 | Schema + migrations |
| `docs/` | Agent 1 | Architecture, DB, security, deployment |

## Key rules (from CONTRACT.md)

- Argon2id passwords, AES-256-GCM provider credentials, SHA-256 router API keys
  (displayed once only). Never send provider keys or full router keys to the frontend.
- Per-user isolation on every query. Zod-validate every input.
- `GET /health` answers without DB/Redis. Gateway base: `/v1`.
- RTK-style token saving lives **inside** the gateway (no second proxy).
- Each agent/task holds an **ordered list** of models (fallback chain), not one model.
