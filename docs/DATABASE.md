# Database — Jhinuk AI Router

PostgreSQL 16 + Prisma. Lean schema: `prisma/schema.prisma`, initial
migration `prisma/migrations/0001_init/migration.sql` (hand-written to match
the schema; run `npx prisma migrate dev` / `prisma migrate deploy` against a
real Postgres to verify — no live DB exists in the build VM yet).

## Models (CONTRACT.md names/fields)

| Model | Purpose |
| --- | --- |
| User | email (unique), passwordHash (Argon2id), totpSecret/totpEnabled, status ACTIVE\|SUSPENDED |
| Role / Permission / UserRole / RolePermission | RBAC. Roles seeded: SUPER_ADMIN, ADMIN, MANAGER, USER, VIEWER |
| Team / TeamMember | Teams (owner + members with a role string) |
| UserSession | Opaque session tokens, SHA-256 `tokenHash`, expiresAt, revokedAt |
| PasswordResetToken | **Agent 1 addition** (not in CONTRACT.md) — required by `/auth/password-reset/*`; token stored as SHA-256 hash, single-use, 1h expiry |
| Provider | name, type (openai/anthropic/gemini/deepseek/moonshot/glm/openrouter/tokens/ollama/custom), baseUrl, protocol, enabled, isGlobal, ownerId (null = global), priority, timeoutMs |
| ProviderCredential | `encryptedKey` TEXT (AES-256-GCM iv+ciphertext+tag, base64), `keyHint` (last 4), rotatedAt |
| AIModel | providerId + modelId (unique together), contextWindow, maxOutputTokens, capability flags, enabled |
| ModelPricing | input/output price per 1M tokens, currency BDT\|USD (default USD), effectiveFrom/To |
| ApiKey | SHA-256 `keyHash`, `keyPrefix` (first 12 chars), expiresAt, lastUsedAt, revokedAt, restrictions JSON |
| RoutingProfile | mode AUTOMATIC\|MANUAL\|HYBRID, `taskMapping` JSON = ordered per-task chains `Record<string, Array<{provider, model}>>`, preferredProviderId, excluded/fallback model IDs, budgetDailyCredits, isDefault |
| RoutingRule | profileId, taskCategory, providerId?, modelId?, priority |
| FallbackRule | userId?, profileId?, fromModelId?, toModelId, trigger, order |
| UsageRecord | requestId (unique), provider, model, routingMode, taskCategory?, input/output/cached tokens, **`tokensSaved`** (RTK), estimatedCost, platformCharge, latencyMs, status. **Never stores raw prompts or provider keys.** |
| CreditWallet | userId (unique), balance, currency (default BDT) |
| CreditTransaction | walletId, signed amount, type PURCHASE\|DEBIT\|REFUND\|ADJUSTMENT, **`idempotencyKey` (unique)**, requestId?, description?. Immutable — no updates/deletes. |
| AuditLog | userId?, action, resource, resourceId?, meta JSON, ip? |
| ProviderHealth | providerId (unique), status UP\|DEGRADED\|DOWN, lastLatencyMs, lastErrorRate, lastCheckedAt, consecutiveFailures, cooldownUntil |
| SystemSetting | key (unique), value JSON, updatedBy? |

## Notes / deviations

- **FallbackTrigger enum**: DB values are `T429` / `T5XX` / `TIMEOUT` /
  `UNAVAILABLE` — Postgres enum labels cannot start with a digit. The API
  maps them to `"429"` / `"5XX"` (see `packages/shared`).
- **PasswordResetToken** is an addition: the CONTRACT requires
  `/auth/password-reset/request|confirm` but defines no table for the token.
- Seed data in `0001_init`: the 5 roles and 21 permissions.
- Indexes: `UserSession(tokenHash)`, `ApiKey(keyHash)`, `UsageRecord(userId,
  createdAt)` + `(provider, model)`, `CreditTransaction(walletId, createdAt)`,
  `AuditLog(userId, createdAt)` + `(resource, createdAt)`.
- The first registered user becomes SUPER_ADMIN (bootstrap); later users get
  USER. Change roles via `POST /api/v1/admin/users/:id/roles`.
