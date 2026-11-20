# Security — Jhinuk AI Router

## Credentials & secrets

- **Passwords**: Argon2id (`argon2` package, memory 19 MiB, time 2, parallelism 1).
  Never stored or logged in plaintext.
- **Provider API keys**: AES-256-GCM, key from `ENCRYPTION_MASTER_KEY`
  (64 hex chars = 32 bytes). Stored format: `base64(iv 12B ‖ ciphertext ‖ tag 16B)`.
  The master key is **never** stored in the DB. Decryption happens only
  server-side, at request time (Agent 2 gateway).
- **Router API keys** (`rk_live_…`): only the SHA-256 hash is stored.
  The full key is returned **once** at creation/regeneration and never again;
  the dashboard shows only `keyPrefix` (first 12 chars). Regeneration revokes
  the old key first.
- **Session tokens**: opaque random 32-byte tokens, SHA-256 hashed in
  `UserSession`, 30-day expiry, revocable per device; all sessions revoked on
  password reset and on suspend.
- **Password-reset tokens**: SHA-256 hashed, single-use, 1h expiry; the
  request endpoint always returns the same neutral response (no user enumeration).
- **TOTP**: RFC 6238, SHA-1, 30s step, 6 digits, ±1 step skew. Secret shown
  once at setup; `totpEnabled` only after a verified code.
- **`.env.example` contains placeholders only.** `.env` is git-ignored
  (`.gitignore` covers `.env*` except `.env.example`).

## Input & transport

- Zod validates every request body/query (`lib/validate.ts` → 400 on failure).
- Rate limiting: in-memory fixed window (300 req/min per IP+path, `/health`
  exempt). Gateway per-key limits are Agent 2's.
- CORS: single allowed origin from `CORS_ORIGIN` (default localhost:3000).
- Secrets are redacted from logs (`lib/logger.ts` — patterns for `sk-…`,
  `rk_live_…`, `Bearer …`, `encryptedKey`).
- Error responses never leak stack traces (generic 500 in production).

## Authorization & isolation

- Every query is scoped by `userId`/`ownerId`. API-key routes 404 (not 403)
  for another user's key — no existence leak.
- Admin routes require SUPER_ADMIN or ADMIN (`requireAdmin`); role checks
  load the user's roles from the DB per request.
- Suspended users cannot log in and their sessions are revoked immediately.
- Admins cannot suspend their own account.

## SSRF (custom providers — Agent 2 enforces at provider creation)

Custom provider `baseUrl` must reject localhost / `127.x` / `10.x` /
`172.16/12` / `192.168.x` / `169.254.x` / cloud metadata unless an admin
explicitly sets SystemSetting `allowLocalProviders=true` (settable via
`PATCH /api/v1/admin/system-settings`). Ollama (`http://localhost:11434/v1`)
is local-only via explicit admin config.

## What is NOT done yet

- No email transport: password-reset tokens are created but no reset email is
  sent (Phase 2, SMTP settings). See `docs/IMPLEMENTATION_STATUS.md`.
- No per-key gateway rate limiting yet (Agent 2, `/v1`).
- No secret-rotation job for `ENCRYPTION_MASTER_KEY` (rotate manually:
  re-encrypt credentials; `rotatedAt` is tracked per credential).
