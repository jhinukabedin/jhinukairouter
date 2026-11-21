# Implementation Status — Jhinuk AI Router (Agent 1: Foundation / Auth / Infra)

Last updated: 2026-11-20 (Phase 1 — foundation). Honest status: what is done,
what is tested, and what is **not** live-verified.

## Done (Agent 1 scope)

- Root: `package.json` (npm workspaces `apps/*`, `packages/*`; scripts
  dev/build/test/typecheck), `tsconfig.base.json`, `.gitignore` (never commits
  `.env`/secrets), `.env.example` (placeholders only), `README.md`.
- `docker-compose.yml` — LIGHT: api + Postgres; Redis behind `--profile redis`;
  api starts without Redis. `docker/Dockerfile.api` (node:24-alpine,
  multi-stage, non-root, single Fastify process, healthcheck).
  `docker/nginx.conf` — reverse proxy to api:3001 (`/v1` SSE no-buffering,
  `/api`, `/health`) + static dashboard.
- `prisma/schema.prisma` — lean schema, exact CONTRACT model/field names,
  including `UsageRecord.tokensSaved`, `RoutingProfile.taskMapping` JSON
  (ordered chains), `FallbackRule`, `CreditWallet`/`CreditTransaction`
  (idempotencyKey unique), `ProviderHealth`, `SystemSetting`.
  `prisma/migrations/0001_init/migration.sql` — hand-written to match the
  schema + seed roles/permissions.
- `packages/shared` — TaskCategory, RoutingMode, NormalizedChatRequest/
  Response, default task mapping seed, per-agent chain type
  `Record<string, Array<{provider, model}>>`, `DEFAULT_AGENT_CHAINS`
  (coordinator/fast/coder/developer/reasoner/architect).
- `packages/config` — Zod env validation; `REDIS_URL` optional with
  graceful fallback (empty string = unset).
- `apps/api` — `app.ts`, `server.ts`, `lib/{crypto (AES-256-GCM),
  password (Argon2id), jwt (HS256), totp (RFC 6238), errors, logger
  (secret redaction), db (narrow interface + real Prisma wiring),
  audit, validate}`.
  - `plugins/auth.ts` — session auth (opaque token, SHA-256 stored),
    `requireRoles` / `requireAdmin`.
  - `plugins/rate-limit.ts` — in-memory fixed-window limiter (Redis optional).
  - Modules: `auth` (register/login/logout/refresh/sessions/password-reset/
    TOTP setup+verify), `users` (GET /users/me), `roles` (CRUD + permissions),
    `api-keys` (create/display-once/hash/revoke/regenerate/expiry/last-used),
    `admin` (users list/create/patch/suspend/activate/set-role, audit-logs,
    system-settings), `health` (GET /health no-DB, GET /health/ready DB ping).
- Tests: Vitest + Fastify inject, in-memory fake Db (`src/test/fake-db.ts`) —
  no live Postgres/Redis needed.
- Docs: `docs/ARCHITECTURE.md`, `docs/DATABASE.md`, `docs/SECURITY.md`,
  `docs/DEPLOYMENT.md` (includes **"Deploy to router.developersbd.top
  (BHPanel)"** — Websites → subdomain, Containers (Podman, no Docker CLI),
  Nginx + AutoSSL, panel Postgres, health + OpenCode URLs),
  this file.

## Test results (verified 2026-11-20 ~04:29 Asia/Dhaka, in this VM)

- `npm install`: works only with `--ignore-scripts` — the `@prisma/engines`
  postinstall tries to download Prisma engine binaries and fails with
  `ECONNRESET` (binaries.prisma.sh unreachable from this VM). With
  `--ignore-scripts` the install completes: `changed 249 packages`.
  Earlier `npm install` attempts also hit transient `ENOTEMPTY` rename
  errors from a concurrent install by another builder in the same root,
  and at ~04:25 `node_modules/` was found deleted (rebuilt since).
- `npx tsc --noEmit -p apps/api/tsconfig.json`: **0 errors in Agent 1 files**
  (lib, plugins, app/server, modules auth/users/roles/api-keys/admin/health,
  test helpers). **12 errors remain, all in other builders' in-progress
  files** (gateway, providers, routing, usage, provider-sdk) — not Agent 1
  scope; `npm run build --workspace=apps/api` fails on those today.
  `packages/shared` and `packages/config`: typecheck clean, builds pass.
- Vitest (`apps/api`, mocked Prisma / in-memory fake Db, no live DB/Redis):
  **8 test files, 42 tests, 42 passed, 0 failed** (auth 10, api-keys 3,
  admin 6, health 2, crypto 6, jwt 4, totp 4, packages/config+shared 7).
- `prisma validate` / `prisma generate`: **cannot run in this VM** —
  Prisma 6 CLI needs to download its engines and the download fails with
  `ECONNRESET`; `npx prisma` instead fetched Prisma 8 RC (no `validate`
  command there). Schema syntax is therefore **not machine-verified**;
  verify on a machine with network access to binaries.prisma.sh.

## NOT live-verified (pending VPS / real services)

- **DB migrations**: no Postgres in this VM — `migration.sql` is hand-written
  and unapplied. Verify with `npx prisma migrate deploy` against real Postgres.
- **Prisma Client generation**: `npx prisma generate` not yet run (needs the
  install to finish); `createDb()` dynamic-imports `@prisma/client`.
- **Docker**: no Docker in this VM — `Dockerfile.api` and `docker-compose.yml`
  are unbuilt/unrun.
- **BHPanel deploy**: NOT deployed. `router.developersbd.top` does not exist
  yet (subdomain/container/DB all pending, per CONTRACT).
- **Email**: password-reset tokens are created, but no reset email is sent
  (no SMTP configured yet — Phase 2).
- **Gateway /v1 routes**: Agent 2 owns them — not in this phase.

## Contract deviations (deliberate, documented)

1. `PasswordResetToken` model added (not in CONTRACT.md) — the contract
   requires `/auth/password-reset/*` but defines no table for the token.
2. `FallbackTrigger` DB enum values are `T429`/`T5XX` (Postgres enum labels
   cannot start with a digit); the API maps them to `"429"`/`"5XX"`.
3. First registered user becomes SUPER_ADMIN (bootstrap); later users get USER.
4. JWT (`lib/jwt.ts`, HS256) is implemented but sessions are opaque tokens;
   JWT is available for short-lived dashboard assertions only.
5. `exactOptionalPropertyTypes` was removed from `tsconfig.base.json`
   (strict TS kept): it clashed with Zod-derived partial objects across the
   whole repo and is beyond `strict`. This also cleared the same class of
   errors in other builders' files.
6. `LOG_LEVEL` accepts `'silent'` (Fastify logger level, needed by tests).

## Standing permission rule (Jhinuk, 20 Nov 2026)

"Allow all but server theke kichu delete korar age permission niba" — all
work is allowed without asking again EXCEPT deleting anything from the
server. NEVER delete subdomains, container apps, files/folders under
`/home/devel4510/`, databases, backups, or any existing site/app (DCMS,
Gitea, old OmniRoute/Ollama leftovers) without his explicit permission in
his own words first. If a step requires a deletion, STOP, explain exactly
what would be deleted and why, and wait for his yes. Also recorded in
`docs/DEPLOYMENT.md` and `CONTRACT.md`.

## Integration verification (coordinator, 20 Nov ~10:35 Asia/Dhaka)

- All 4 builders delivered. Total tests re-run by coordinator: **tests/ 72/72
  passed, apps/api 42/42 passed, apps/web 7/7 passed = 121/121, 0 failed.**
- Web build (`npm run build` in apps/web): **PASS** — 225.78 kB JS (67.92 kB gzip).
- API typecheck: **12 errors found at handoff, fixed by coordinator**
  (possibly-undefined index access in gateway/routes.ts, routing/chain.ts,
  usage/service.ts, provider-sdk/ssrf.ts); `npx tsc --noEmit` in apps/api is
  now **clean (0 errors)**. The stale note below about the api build failing
  is superseded by this.
- `docker-compose.yml`: valid YAML (Python yaml parse); `docker compose
  config` / build / run NOT verified — no Docker in this VM.
- Prisma: `prisma validate` / `generate` / migrations NOT runnable here —
  Prisma engine download from binaries.prisma.sh fails with ECONNRESET in
  this VM; schema syntax is hand-written and unapplied. Verify on VPS/PC.
- No end-to-end run against a live DB/Redis/provider has happened yet.

## Notes

- During this build another builder ran `npm install` in the same root at
  the same time, causing transient `ENOTEMPTY` rename errors; at ~04:25
  `node_modules/` was found deleted entirely and had to be rebuilt
  (`npm install --ignore-scripts` — see Test results above).
- `npm run build --workspace=apps/api` currently fails on 12 type errors in
  other builders' in-progress modules (gateway/providers/routing/usage/
  provider-sdk); Agent 1 files compile cleanly.
- Other builders' files already present in `apps/api/src/modules/`
  (gateway, providers, models, routing, usage, billing) were **not** touched.

## Live wiring (20 Nov 2026 ~12:20–12:35 Asia/Dhaka, post-deploy)

Found during the BHPanel deploy: every module was tested in isolation, but
`buildApp` never registered the providers/models/routing/usage/billing
dashboard routes or the `/v1` gateway — the deployed API answered only
`/health` and `/api/v1/auth/*`. Fixed in `apps/api/src/modules/wiring.ts`
(`registerAllModules`, called from `app.ts`):
- Dashboard routes registered with session auth (providers/models via a
  boolean guard; routing/usage/billing via a preHandler that also records
  admin status for `isAdmin`).
- Gateway registered encapsulated under prefix `/v1` (its auth hook must
  not see non-`/v1` traffic). Key lookup is dynamic against Postgres
  (`apiKey.findMany` by `keyHash` — added to the `Db` interface + FakeDb).
  Chain resolution: an explicitly requested model resolves directly
  (store resolver); otherwise the RoutingService (profiles/default mapping)
  decides. Usage is recorded into the usage service (provider cost 0 and
  marked as estimate — pricing not wired yet).
- `apps/api/src/modules/static/index.ts` serves the built dashboard from
  the API process (`PUBLIC_DIR`, default `./public`; the web `dist/` is
  copied into the image). Reason: BHPanel has no per-path proxy, so the
  whole site attaches to the container (see DEPLOYMENT.md Step 5).
- `packages/protocols` and `packages/provider-sdk` are now **compiled to
  dist** like shared/config (build scripts added; `main`/`types`/`exports`
  point at dist; `declaration: true`; `rootDir: "src"`). They used to be
  consumed as TypeScript source via Node type-stripping, which does NOT
  resolve `.js` → `.ts` specifiers in this runtime (verified by repro on
  Node v24.22.1) — the server crashed on startup once the gateway was
  wired in. Their `import type` references to shared src are now package
  imports (`@jhinuk-ai-router/shared`). This also fixed their pre-existing
  `tsc` TS6059 typecheck failures.
- Vitest configs (root + apps/api) now alias the four workspace packages
  to their TS sources, so tests never load two copies of a package (src +
  dist) — the dual copy broke `instanceof ProviderHttpError` and with it
  gateway fallback (4 root tests failed before the alias).
- Tests now **126/126**: root 72/72, apps/api 47/47 (was 42; +3 static,
  +2 wiring), apps/web 7/7. API + web builds pass; typecheck clean in
  shared/config/protocols/provider-sdk/api.
- Live smoke test (no DB in this VM): `/` serves the dashboard (200),
  `/health` ok v0.1.1, `/v1/models` 401 JSON without a key, dashboard
  routes 401 without a session, `/health/ready` degraded (DB down here).

Known limitation (standing design, not a bug): providers, models, routing
profiles, usage rows and billing data live in **in-memory stores** and
reset on container restart. Users, sessions and router API keys live in
Postgres and survive restarts. Prisma-backed stores are a later step.

## 0.1.2 — mobile menu + admin registration toggle (20 Nov ~13:40, not yet deployed)

User report: the dashboard menu does not show on phones, and registration
on/off should be controllable from the admin dashboard instead of an env var.

- **Mobile menu fixed** (`apps/web/src/components/Layout.tsx`): the sidebar
  was `hidden ... md:block`, so phones had no navigation at all. There is now
  a ☰ Menu button in the header (below `md` only) opening a slide-over drawer
  with the same links; it closes on navigation (link click / hashchange).
- **Registration toggle** (admin-controlled, no restart, no redeploy):
  - New `apps/api/src/lib/settings.ts`: `isRegistrationEnabled(db, env)` —
    the `SystemSetting` row `registration.enabled` (boolean) wins; when no row
    exists the env var `REGISTRATION_ENABLED` applies (default true, so fresh
    installs still bootstrap their first SUPER_ADMIN). Degraded mode (DB down)
    falls back to env instead of 500ing.
  - `POST /api/v1/auth/register` now uses that helper instead of the env var
    directly; new public `GET /api/v1/auth/registration-status` reports the
    effective flag.
  - Admin page → System Settings tab has a **Registration ON/OFF toggle** at
    the top (writes `registration.enabled` via the existing admin PATCH
    endpoint). The login page hides the Register link and the register page
    shows a notice when registration is off.
  - **Fixed two latent bugs found while wiring the toggle:** the web client's
    `systemSettings()` expected an array but the API returns
    `{ settings: { key: value } }` (the System Settings tab would crash on
    render), and `updateSystemSetting()` sent `{ key, value }` while the API
    expects `{ settings: { key: value } }` (every edit was rejected). Both
    now match the API.
- Tests now **133**: root 72/72, apps/api 55/55 (was 47; +5 settings unit,
  +2 auth full-loop incl. DB-true-overrides-env-false), apps/web 7/7. API +
  web builds pass; typecheck clean. Live smoke test (no DB in this VM):
  `/` 200, `/health` ok v0.1.2, `/api/v1/auth/registration-status`
  `{"registrationEnabled":true}` (env default).
- Version bumped to 0.1.2 (root + api package.json, health string, workflow
  tags, DEPLOYMENT.md). Deploy = push → Actions build → GHCR 0.1.2 → BHPanel
  recreate container (same env vars; the live env still has
  `REGISTRATION_ENABLED=false`, so the toggle will show OFF until the admin
  flips it — the DB row is created on first flip).

## 0.1.3 — 20 Nov ~20:40 (fixes the live 401: login worked, every later call 401'd)

- **Root cause (verified in code):** `UserSession.tokenHash` is only `@@index`
  in `prisma/schema.prisma`, NOT `@unique` (contrast `PasswordResetToken.
  tokenHash`, which IS `@unique`). `plugins/auth.ts` `authenticate()` used
  `db.userSession.findUnique({ where: { tokenHash } })` — real Prisma throws
  on `findUnique` over a non-unique field, the session guard in `wiring.ts`
  swallows any error and returns false, so every authenticated dashboard
  call 401'd. Login itself worked (it only creates the session row). The
  user proved it live: F5 + re-login + refresh, mobile and PC, Providers
  still showed the red 401 banner and Add provider 401'd. Tests never
  caught it because `FakeDb.findUnique` just scans an array.
- **Fix:** `authenticate()` now uses `findFirst` for the tokenHash lookup
  (`apps/api/src/plugins/auth.ts`); `findFirst` added to the `Db` interface
  (`apps/api/src/lib/db.ts`, PrismaClient has it natively). `FakeDb` gained
  `findFirst`, and its `findUnique` now throws on `tokenHash` exactly like
  real Prisma, so a regression fails the suite. New regression test in
  `apps/api/src/modules/auth/auth.test.ts`: register → login token → GET
  `/api/v1/providers` 200 + POST `/api/v1/providers` 201 (the exact user
  flow). `User.email` / `Role.name` are `@unique`, so no sibling bug there.
- **Second latent bug found while verifying the fix (would have bitten
  immediately after the 401 fix):** the providers/models modules wrap
  responses as `{ data: ... }`, but the web client treated them as bare
  values — `listProviders`/`listModels` would hand the page an object, and
  `providers.map` would crash. `apps/web/src/lib/api.ts` now unwraps:
  `listProviders`/`listModels` via `normalizePaged().data`, `createProvider`
  / `updateProvider` / `testProvider` / `syncProviderModels` /
  `createModel` / `updateModel` via new `unwrapData`, `listApiKeys` via
  `unwrapKey(..., 'apiKeys')` (API returns `{ apiKeys: [...] }`),
  `sessions` via `unwrapKey(..., 'sessions')`, `adminUsers` via
  `unwrapKey(..., 'users')`; `normalizePaged` also accepts `{ logs }`
  (audit-logs). New web test `apps/web/src/lib/__tests__/api-shape.test.ts`.
  Routing profiles, usage summary, wallet, users/me and admin user create
  return bare values and needed no change. `/api/v1/admin/provider-health`
  has no API route at all (web call is caught and defaults to []); left
  for a later version.
- **Third fix:** `api.ts` error parsing now reads `body.error.message` too
  (the API returns `{ error: { code, message } }`; the client only read a
  top-level `message`, so every error showed as bare "Request failed
  (401)" and hid the real reason).
- Version bumped to 0.1.3 (root + api package.json, health string, workflow
  tags, DEPLOYMENT.md). Deploy = push → Actions build → GHCR 0.1.3 → BHPanel
  recreate container (same env vars). After deploy the user re-tests: login
  → Providers loads with no red banner → add Tokens.bd (OpenAI-compatible
  protocol) → Test → Sync Models. The Tokens.bd key itself was verified
  good on 20 Nov via the custom.tokens-bd connector (47 models incl.
  openai/gpt-6-luna); the 401 was never a bad key.

## 0.1.4 — 20 Nov ~21:20 (fixes the live Test/Sync "Internal server error")

- **Symptom:** provider Tokensbd saved fine and the Providers page loaded,
  but Test and Sync Models both alerted "Internal server error".
- **Root cause (reproduced locally):** the dashboard POSTs /test and
  /sync-models with NO body, but the web client always sent
  `Content-Type: application/json`. Fastify's JSON parser rejects an empty
  body (`FST_ERR_CTP_EMPTY_JSON_BODY`, a 400), and `app.ts`'s custom error
  handler only recognised AppError and `validation` errors — every other
  error became a 500. So Create (sends a body) worked while every
  body-less POST (Test, Sync Models, logout, suspend/activate, DELETEs)
  500'd. The provider call itself was never the problem: the adapter's
  testConnection returns false on provider failure, and listModels throws
  a catchable ProviderHttpError (verified with a dummy key: 401 "Invalid
  API key." from tokens.bd, no Cloudflare block on the adapter's fetch).
- **Fix, two layers:** (1) `apps/api/src/app.ts` — the error handler now
  honours Fastify's own 4xx `statusCode` (code + message, truncated)
  instead of masking client mistakes as 500. (2) `apps/web/src/lib/api.ts`
  — `request()` only sends `Content-Type: application/json` when a body
  is actually present, so a body-less POST never hits the parser.
- **Full-page audit (same release, user's voice request 21:21):** every
  dashboard page's API calls were checked against the API's real return
  shapes. Three more "nothing shows up" bugs found, all in
  `apps/web/src/lib/api.ts`:
  (1) Usage list and credit transactions answer `{ rows, total, ... }`,
  but `normalizePaged` only read `data`/`items`/`logs` — so the Usage
  page, Request Logs, Overview's recent list and the Credits transaction
  list always showed empty. `normalizePaged` now also accepts `rows`.
  (2) `wallet()` called GET `/api/v1/credits`, which has no route — the
  API only serves `/api/v1/credits/wallet`, so the wallet card on
  Overview/Credits always 404'd. Now calls `/api/v1/credits/wallet`.
  (3) `adjustCredits` sent `{ userId, amount }` but the API requires
  `{ targetUserId, amount, idempotencyKey }` — every admin credit adjust
  400'd. The client now maps the id and mints an idempotency key per
  submission. Pages checked clean: Models (create/update returns
  ignored, page reloads), Routing Profiles (bare profile/fallback-rule
  shapes), Client Setup (gateway URL is `…/v1`, test fetches
  `/v1/models` correctly), Settings (TOTP page only reads `secret`;
  sessions DELETE returns `{ok:true}`), Admin (suspend/activate
  `{ok:true}`, update returns bare user). Known gaps NOT fixed here:
  `/api/v1/admin/provider-health` still has no API route (Admin page
  catches and shows []), and Usage pagination sends `page` which the
  API ignores (limit/offset only) — first page works.
- **Tests:** new `apps/api/src/modules/providers/empty-body.test.ts` (2):
  empty body + JSON content-type now answers 400 with
  `FST_ERR_CTP_EMPTY_JSON_BODY` (not 500); body-less POST without a
  content-type reaches the handler (Test 200 ok:false with a dummy key,
  Sync 502 "sync failed"). The repro was written red first (both 500),
  then turned green by the fix. Plus one `{ rows }` case in the web
  `api-shape` test. Tests now **141**: root 72/72, apps/api 58/58
  (was 56), apps/web 11/11 (was 10). Typecheck clean, API + web builds
  pass, smoke test on the built server: / 200, /health ok v0.1.4,
  registration-status true (smoke env), /v1/models 401.
- Version bumped to 0.1.4 (root + api package.json, health string, workflow
  tags, DEPLOYMENT.md). Deploy = push → Actions build → GHCR 0.1.4 →
  BHPanel recreate container (same env vars). **After deploy the
  in-memory providers/models are wiped again — the user must re-add the
  Tokensbd provider (OpenAI-compatible protocol, 20:10 key
  tok_live_9aa7744b…), then Test (expect "Connection OK") then Sync
  Models. Usage/Logs/Credits pages will also show rows now.**

**0.1.4 LIVE 20 Nov ~21:33** — container updated in place to GHCR 0.1.4
(Actions run 44763880357 SUCCESS, workflow tag commit b508da4, code HEAD
d3ab2b76, sync record 33 entries). Verified live: / 200, /health ok v0.1.4,
database up, registration closed, /v1/models 401. Providers/models were
wiped by the restart as expected — user re-adds Tokensbd after this.
Still open (found in the 21:30 page audit, for 0.1.5): Usage/Request Logs
pagination sends `page` which the API ignores (always first 25 rows);
Sync Models alert shows "[object Object]" (models are objects, not id
strings); Routing Profiles "Test chain" sends the dashboard session token
but /v1 only accepts router API keys (always 401).

## 0.1.5 — 21 Nov (fixes the blank page after login + the rest of the page audit)

- **Symptom (reported 21 Nov 11:17):** after a fresh login the dashboard
  shows a blank page. Login itself works; the reload lands on Overview.
- **Root cause (verified in code):** the usage-summary API returns the
  breakdowns as RECORDS keyed by model/provider/key/user
  (`byModel: {"tokens/gpt-6-luna": {requests, inputTokens, outputTokens,
  estimatedCost}}`), with `estimatedProviderCost` / `platformCreditUsed`
  at the top — but the web client typed them as ARRAYS with a `cost`
  field, and Overview does `summary.byModel.map(...)`. `{}.map` throws,
  React unmounts, blank page. Why it only bit now: in 0.1.2 auth was
  broken so the summary call 401'd (summary null, no crash); in 0.1.3
  the user stayed on the Providers hash and never freshly landed on
  Overview; the first fresh login on 0.1.4 loaded the summary
  successfully — and crashed. Usage.tsx guarded with `?.length`, so it
  showed empty breakdowns instead of crashing.
- **Fix:** `apps/web/src/lib/api.ts` gains `normalizeUsageSummary()`
  (wire record -> page array, `estimatedCost`/`platformCreditUsed` ->
  `estimatedCost`/`platformCharge`, buckets and daily/monthly
  `estimatedCost` -> `cost`; accepts already-normalised arrays too, so
  a future API change cannot blank the page again) and `usageSummary()`
  applies it; `health()` maps `uptimeSeconds` -> `uptimeSec` (the page
  showed "Uptime 0 min"). Pagination (audit #2): new `withOffset()`
  translates page -> offset for `usageList`/`transactions` (the APIs
  take limit/offset only) and `normalizePaged` derives the page from
  offset/limit. Sync (audit #3): `toModelIds()` turns the returned
  model objects into id strings (the alert showed "[object Object]").
  Test chain (audit #4): `testGatewayChat(model, routerKey)` takes the
  router API key as a parameter; Routing Profiles has a "Router API key
  (for Test buttons)" field stored in localStorage
  (`jar_router_test_key`), with a hint to create one on the API Keys
  page — the gateway never accepted the dashboard session token.
- **Tests:** 5 new cases in `apps/web/src/lib/__tests__/api-shape.test.ts`
  (normalizeUsageSummary wire/empty/array shapes, withOffset,
  toModelIds, normalizePaged page-from-offset). Tests now **146**:
  root 72/72, apps/api 58/58, apps/web 16/16 (was 11).
- Version bumped to 0.1.5 (root + api package.json, health string, workflow
  tags, DEPLOYMENT.md). Deploy = push -> Actions build -> GHCR 0.1.5 ->
  BHPanel container update (same env vars). After deploy the user
  re-adds the Tokensbd provider (still not added) and logs in fresh —
  Overview must render with the stats cards and empty breakdowns.

**0.1.5 LIVE 21 Nov ~11:32** — container updated in place to GHCR 0.1.5
(Actions run 44870994314 SUCCESS, workflow tag commit dbedf46, code HEAD
fbfd07d8, sync record 34 entries). Verified live: / 200, /health ok v0.1.5,
database up, registration closed, /v1/models 401. The blank page after
login is fixed by the client-side summary normalisation; the user logs in
fresh and Overview renders. Providers/models were wiped by the restart as
expected — user still has to add the Tokensbd provider (not added yet).

## 0.1.6 — 21 Nov (OpenRouter sync: free models only)

- **Ask (user, 21 Nov 12:04):** "openrouter er sob model sync hoyeche ami
  chai shudhu free gulo" — the OpenRouter sync pulled the whole catalog
  (hundreds of paid models); he wants only the free ones.
- **Fix:** providers gain a `freeOnly` flag (schema + create + PATCH;
  `toPublic` already spreads the whole record, so list responses carry
  it). When `freeOnly` is on for an OpenRouter provider (type
  `openrouter` or baseUrl containing `openrouter.ai`), sync keeps only
  model ids ending in `:free` — OpenRouter's free-tier marker — and
  prunes paid models synced earlier (only when the filtered sync
  returned models, so an empty provider answer can never wipe the
  list). The flag is ignored for other providers (their ids never carry
  the suffix; filtering them would sync zero models). The sync response
  gains `pruned`. Dashboard: the Add-provider form shows an "Only sync
  free models (:free)" checkbox for OpenRouter, and each OpenRouter row
  has a "Free only: On/Off" toggle (there is no edit form, so the
  existing provider gets the flag this way); the sync alert reports the
  pruned count.
- **Tests:** new `apps/api/src/modules/providers/free-only.test.ts` (3,
  fetch stubbed with a mixed OpenRouter catalog): sync-all then
  PATCH freeOnly + re-sync prunes the 2 paid models; freeOnly at
  creation syncs only the 2 `:free` models; the flag is ignored for a
  Tokens provider. Tests now **149**: root 72/72, apps/api 61/61 (was
  58), apps/web 16/16.
- Version bumped to 0.1.6 (root + api package.json, health string, workflow
  tags, DEPLOYMENT.md). Deploy = push -> Actions build -> GHCR 0.1.6 ->
  BHPanel container update (same env vars). After deploy the user
  re-adds the providers (in-memory wipe) — Tokens.bd as before, and
  OpenRouter with the free-only box ticked (or the row toggle + Sync).

## 0.1.7 — 21 Nov (manual Add model + free-only sync never removes hand-added models)

- **Ask (user, 21 Nov 12:16):** "ekta option kora jay sync korle free ja
  thakbe segulo asbe r ekta button thakbe ta holo add model jodi paid hoy
  tobe model add kora jabe" — sync should bring only free models, and
  there should be an Add Model button so a paid model can still be added
  by hand.
- **Fix:** models now carry `source: 'synced' | 'manual'`. Sync-created
  models are 'synced'; the direct POST /models path (dashboard Add Model
  form) is 'manual'. The 0.1.6 prune now skips manual models — a paid
  model added by hand survives every later free-only sync (without this
  the next sync would have deleted exactly the model he had just added).
  Dashboard: every provider row has an "Add model" button (prompts for
  the exact model id, adds it to that provider with sync-like defaults);
  the full Add Model form still exists on the Models page (provider,
  pricing, capabilities). The Models table marks hand-added rows
  "· manual".
- **Tests:** free-only suite grows to 4 (new: a manually added paid
  model survives a free-only sync while the synced paid one is pruned).
  Tests now **150**: root 72/72, apps/api 62/62 (was 61), apps/web 16/16.
- Version bumped to 0.1.7 (root + api package.json, health string,
  workflow tags, DEPLOYMENT.md). NOTE: 0.1.6 was pushed to GitHub
  (HEAD 9226ef23) but never deployed — 0.1.7 folds it in, so the
  workflow tag goes 0.1.5 -> 0.1.7 in one edit and there is only one
  container restart / one provider re-add. Deploy = push -> Actions
  build -> GHCR 0.1.7 -> BHPanel container update (same env vars).
