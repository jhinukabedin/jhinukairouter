# Deployment — Jhinuk AI Router

> **Status: code is deployment-ready, NOT deployed.** Nothing has been
> created on the server yet — no subdomain, no container, no database.
> This document describes how to deploy; it does not claim it was done.

## Target

- **Production URL**: `https://router.developersbd.top`
- **Health**: `https://router.developersbd.top/health`
- **Gateway (OpenCode base URL)**: `https://router.developersbd.top/v1`
- **Dashboard**: `https://router.developersbd.top/`
- **Server**: BHPanel/cPanel, AlmaLinux, `server.lotusgtl.com`
- **Panel user**: `devel4510`, home `/home/devel4510/`
  (DCMS lives at `/home/devel4510/dcms.top` — the router is a separate app)
- **Containers**: BHPanel **Containers (Podman)** — there is **NO Docker CLI**
  for this account. Do not use `docker` commands on the server.

## Standing permission rule (Jhinuk, 20 Nov 2026 — "allow all but server theke kichu delete korar age permission niba")

- **Allowed without asking again:** building the router code, creating files in
  `~/workspace/jhinuk-ai-router/`, creating the `router.developersbd.top`
  subdomain, deploying the container, configuring Nginx/HTTPS, creating
  databases, adding providers/models, running tests.
- **NEVER delete from the server without his explicit permission in his own
  words first:** no deleting subdomains, container apps, files/folders under
  `/home/devel4510/`, databases, backups, or any existing site/app (including
  DCMS, Gitea, old OmniRoute/Ollama leftovers). If a step requires a deletion
  (e.g. removing an old subdomain/container to replace it), **STOP that step,
  explain exactly what would be deleted and why, and wait for his yes.**

## What the app needs to run

One small Node 24 process (API, `PORT` default 3001) + PostgreSQL 16.
Redis is **optional** — the API starts and serves `/health` and `/v1`
without it (in-memory rate limiting / queue fallback).

Required env vars (see `.env.example` — placeholders only, fill with real
values in the panel, never commit them):

| Var | Value |
| --- | --- |
| `DATABASE_URL` | `postgresql://router:<password>@<pg-host>:5432/jhinuk_router?schema=public` |
| `REDIS_URL` | _(optional, leave empty if no Redis)_ |
| `PORT` | `3001` |
| `NODE_ENV` | `production` |
| `LOG_LEVEL` | `info` |
| `CORS_ORIGIN` | `https://router.developersbd.top` |
| `SESSION_SECRET` / `JWT_SECRET` | random, ≥32 chars each (`openssl rand -hex 32`) |
| `ENCRYPTION_MASTER_KEY` | 64 hex chars (`openssl rand -hex 32`) — AES-256-GCM master key |
| `ROUTER_MASTER_KEY` | random string, ≥16 chars |
| `REGISTRATION_ENABLED` | `true` (set `false` after creating the first admin) |
| `REQUIRE_EMAIL_VERIFICATION` | `false` |

## Deploy to router.developersbd.top (BHPanel)

### Step 1 — Create the subdomain
1. Log in to BHPanel (`server.lotusgtl.com`) as `devel4510`.
2. Go to **Websites** (or **Domains → Subdomains**).
3. Create subdomain **`router`** under domain **`developersbd.top`**
   → document root e.g. `/home/devel4510/router.developersbd.top`
   (the API container does not need the document root; it is used for the
   static dashboard build).
4. Wait for DNS to resolve: `router.developersbd.top` should answer
   (it already resolves to the server IP, but no site exists yet).

### Step 2 — Create the database
1. In BHPanel go to **Databases → PostgreSQL** (panel-managed, preferred).
2. Create database **`jhinuk_router`**, user **`router`**, strong password.
3. Note the host/port (usually `localhost:5432` from inside the panel).
4. If the panel has no managed Postgres: use the `docker-compose.yml`
   alternative below on a plain Docker VPS instead, or run Postgres as a
   Podman container in BHPanel Containers (same image `postgres:16-alpine`,
   data volume mounted, port bound to `127.0.0.1:5432` only — **never expose
   Postgres publicly**).
5. Apply migrations once, from any machine that can reach the DB:
   ```bash
   DATABASE_URL='postgresql://router:<password>@<host>:5432/jhinuk_router?schema=public' \
     npx prisma migrate deploy
   ```
   (Or `npx prisma db push` for a first-time setup.)

### Step 3 — Build the API image
Build on a machine with Docker (local PC or CI), then push to a registry
the server can pull from (e.g. Docker Hub / GHCR — private repo):
```bash
docker build -f docker/Dockerfile.api -t ghcr.io/jhinukabedin/jhinukairouter-api:0.1.0 .
docker push ghcr.io/jhinukabedin/jhinukairouter-api:0.1.0
```
The image is small (node:24-alpine, production deps only, non-root user
`router`, single Fastify process).

### Step 4 — Deploy the container in BHPanel (Podman, no Docker CLI)
1. In BHPanel go to **Containers** (Podman).
2. **Create / Deploy container** → image `ghcr.io/jhinukabedin/jhinukairouter-api:0.1.0`.
3. Set the container name, e.g. `router-api`.
4. **Environment variables**: paste every var from the table above
   (DATABASE_URL pointing at the panel Postgres, PORT=3001, etc.).
5. **Port mapping**: container `3001` → host port `3001` on `127.0.0.1`
   (do not expose it publicly — Nginx proxies to it).
6. **Restart policy**: always / unless-stopped.
7. (Optional) Redis: if the panel offers managed Redis, add `REDIS_URL`;
   otherwise leave it empty — the router runs fine without it.
8. Start the container and check its logs for
   `[router] listening on http://0.0.0.0:3001`.

### Step 5 — Nginx reverse proxy + HTTPS (AutoSSL)
1. In BHPanel, open the **router.developersbd.top** site settings
   (Websites → the subdomain → proxy / Nginx settings, or the panel's
   Node.js / reverse-proxy section — exact labels vary by BHPanel version).
2. Proxy these paths to `http://127.0.0.1:3001`:
   - `/v1/` → gateway (SSE streaming: **disable proxy buffering**, read
     timeout 300s)
   - `/api/` → dashboard API (timeout 60s)
   - `/health` → health check
3. Serve the dashboard: build `apps/web` (`npm run build`) and upload the
   `dist/` contents to `/home/devel4510/router.developersbd.top/` so `/`
   serves the static files (fallback to `index.html` for SPA routes).
   Reference config for a plain-Nginx host: `docker/nginx.conf`.
4. Enable **AutoSSL / Let's Encrypt** for `router.developersbd.top`
   (BHPanel → SSL/TLS Status → Run AutoSSL) and force HTTPS.
5. Verify:
   ```bash
   curl -s https://router.developersbd.top/health
   # {"status":"ok","service":"jhinuk-ai-router","version":"0.1.0",...}
   curl -s https://router.developersbd.top/health/ready
   # {"status":"ready","checks":{"database":"up","redis":"optional"}}
   ```

### Step 6 — First admin + lock down registration
1. Register the first account at `https://router.developersbd.top/` —
   the first user automatically becomes **SUPER_ADMIN**.
2. Log in, create router API keys (ApiKeys page), add providers.
3. Set `REGISTRATION_ENABLED=false` in the container env and restart the
   container (private gateway — no open sign-ups).
4. Create further users from Admin → Users instead.

### Step 7 — OpenCode / client setup
Set the base URL to **`https://router.developersbd.top/v1`** and use a
router API key (`rk_live_…`) as the API key. Keep the local RTK plugin
enabled — RTK saving also runs **inside** the gateway; the plugin and the
router must not both proxy the same request (the router is the base URL,
not a second proxy). Full client guide: Agent 4 `docs/CLIENT_INTEGRATION.md`.

## Alternative: plain Docker VPS (docker-compose)

If BHPanel Containers are unavailable, on any Docker host:
```bash
cp .env.example .env   # fill in real secrets
docker compose up -d            # api + postgres
docker compose --profile redis up -d   # + redis (optional)
docker compose exec api npx prisma migrate deploy
curl http://localhost:3001/health
```
Put Nginx in front using `docker/nginx.conf` as the reference and terminate
TLS there (or with a reverse proxy of your choice).

## Rollback / updates

- The API is stateless; updating = pull the new image, recreate the
  container with the same env vars. Database migrations run via
  `prisma migrate deploy` before starting the new container.
- Back up Postgres before any migration (`pg_dump`).
- If the container fails to start, `/health` will not answer — check
  container logs first; the most common cause is a wrong `DATABASE_URL`
  or a bad `ENCRYPTION_MASTER_KEY` (must be 64 hex chars).
