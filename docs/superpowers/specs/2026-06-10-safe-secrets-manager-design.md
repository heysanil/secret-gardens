# safe — Open-Source Secrets Manager: Design Spec

## Context

Build "safe", an open-source, self-hostable secrets management tool (Doppler/Infisical-style). Teams store secrets per project/environment, view and administer them in a web UI, and pull/push/inject them via a CLI — including in CI via scoped service tokens. Secrets are always encrypted at rest (envelope encryption; Redis only ever sees ciphertext) and in transit (TLS).

License: **AGPL-3.0**.

## Settled decisions

| Decision | Choice |
|---|---|
| Threat model | Server-side master key; server may see plaintext in memory. Zero-knowledge E2EE explicitly out of scope (data model must not preclude it — `alg` field on ciphertext records). |
| Encryption | Envelope: env-var KEK → per-project DEK (wrapped, in SQLite) → AES-256-GCM per secret with AAD `projectId:envId:secretKey`. Native `node:crypto` only — zero crypto deps. |
| Auth | better-auth: email/password + OAuth, `Bun.password` argon2id via `emailAndPassword.password.{hash,verify}`. Org plugin for instance roles. |
| Machine auth | Hand-rolled scoped service tokens (project + envs + read/read_write + expiry). NOT better-auth apiKey plugin (it binds keys to a userId — wrong lifecycle for CI). |
| Data model | Project → environments (user-definable; default dev/staging/prod) → key-value secrets. Versioning + rollback, append-only audit log, per-project RBAC (admin/write/read). |
| Storage | Redis (Bun native `RedisClient`) for ciphertext, versions, audit streams; AOF everysec. SQLite (`bun:sqlite`, WAL) for better-auth tables + projects/envs/memberships/wrapped DEKs/tokens. |
| Stack | Bun everywhere, Turborepo, Elysia API, Vite + React web, CLI (citty), Eden treaty for typed clients, bun:test, Biome. Docker: 2 containers (app + redis). |

Bun-native facts verified against current docs: `createCipheriv("aes-256-gcm")` with AAD/authTag is native; `hkdfSync` available (node:crypto compat lists only `secureHeapUsed`/`setEngine`/`setFips` missing); `Bun.password.hash` supports argon2id; better-auth accepts `new Database()` from `bun:sqlite` directly and mounts on Elysia via `.mount(auth.handler)`; `Bun.redis` is RESP3 with raw `send()` for stream commands.

## Monorepo layout

```
safe/
├── package.json              # workspaces: apps/*, packages/*
├── turbo.json                # build/test/typecheck/lint; dependsOn ^build (Eden types flow from api)
├── tsconfig.base.json, bunfig.toml, LICENSE (AGPL-3.0)
├── apps/
│   ├── api/                  # Elysia — the ONLY process touching Redis/SQLite/KEK
│   │   ├── src/index.ts      # boot: config → migrations → listen
│   │   ├── src/app.ts        # composition root; exports `type App` for Eden
│   │   ├── src/config.ts     # env validation incl. SAFE_MASTER_KEY fail-fast
│   │   ├── src/auth/         # better-auth instance + principal middleware
│   │   ├── src/db/           # bun:sqlite, migration runner, migrations/*.sql
│   │   ├── src/redis/        # secrets.ts + audit.ts (only files using raw send())
│   │   ├── src/routes/       # projects, environments, secrets, members, tokens, audit, health
│   │   ├── src/services/     # secretService, dekService (DEK cache), auditService
│   │   └── scripts/          # rotate-kek.ts
│   ├── web/                  # Vite + React: better-auth/react + TanStack Query/Table + @safe/api-client
│   └── cli/                  # `safe` binary; citty; bun build --compile for releases
├── packages/
│   ├── crypto/               # pure envelope-encryption primitives; zero deps; no IO
│   ├── shared/               # types, role/permission matrix, audit action constants, dotenv codec, .safe.json schema
│   └── api-client/           # Eden treaty wrapper; type-only dep on apps/api; cookie vs Bearer injection
├── docker/Dockerfile, docker-compose.yml
├── scripts/setup.sh          # generates .env: SAFE_MASTER_KEY, BETTER_AUTH_SECRET
├── compose.test.yml          # redis-only for integration tests
└── docs/superpowers/specs/2026-06-10-safe-secrets-manager-design.md
```

Internal package scope `@safe/*`; public npm naming is a publish-time decision.

## Encryption (`packages/crypto`)

```ts
type KekId = string;  // 16 hex chars = hex(sha256(rawKey)).slice(0,16)
interface MasterKey { readonly kekId: KekId }            // wrapping key in closure, not enumerable
interface WrappedDek { wrapped: Buffer; nonce: Buffer; tag: Buffer; kekId: KekId }
interface EncryptedSecret { ct: Buffer; nonce: Buffer; tag: Buffer }
interface SecretAad { projectId: string; envId: string; secretKey: string }

generateMasterKey(): string                               // base64(randomBytes(32)); used by setup.sh
loadMasterKey(env?: string): MasterKey                    // throws unless base64 → exactly 32 bytes;
                                                          // wrappingKey = hkdfSync('sha256', raw, '', 'safe/v1/dek-wrap', 32)
generateDek(): Buffer                                     // randomBytes(32)
wrapDek(mk, dek, projectId): WrappedDek                   // AES-256-GCM, nonce 12B random, AAD `safe-dek:${projectId}`
unwrapDek(mk, w, projectId): Buffer                      // KekMismatchError if kekId differs; DekUnwrapError on tag fail
encryptSecret(dek, plaintext, aad): EncryptedSecret       // AAD = `${projectId}:${envId}:${secretKey}` (nanoid ids — no ':' ambiguity)
decryptSecret(dek, enc, aad): string                      // DecryptError on tag/AAD failure
packEncrypted/unpackEncrypted                             // base64 JSON fields for Redis
```

- HKDF subkey (label `safe/v1/dek-wrap`) rather than using the raw env key directly — future keys (token pepper, v2 schemes) derive from the same env var. `kekId` fingerprints the *raw* input so rotation tooling identifies which env var wrapped which DEK.
- Boot check: `instance_settings['kek_check']` stores a wrap of a known 32-byte constant written at first boot; later boots unwrap it — wrong `SAFE_MASTER_KEY` aborts startup with a precise error instead of runtime 500s.
- DEK cache in `dekService`: `Map<projectId, {dek, version}>`, invalidated on rotation/delete; best-effort `fill(0)` on eviction.
- Rotation: KEK = re-wrap all active `project_keys` rows with `SAFE_MASTER_KEY_NEW` (script; secrets untouched). DEK = new `project_keys` version, re-encrypt project's secrets, mark old row `retired` (kept — old versions carry their `dekV`).

## SQLite schema (ours; better-auth generates `user/session/account/verification/organization/member/invitation`)

```sql
projects(id PK, name, slug UNIQUE, description, created_by→user, created_at, updated_at)
environments(id PK, project_id→projects CASCADE, name, slug, position, created_at, UNIQUE(project_id, slug))
project_memberships(id PK, project_id, user_id, role CHECK IN ('admin','write','read'), UNIQUE(project_id,user_id))
project_keys(id PK, project_id, version, wrapped_dek b64, wrap_nonce b64, wrap_tag b64, kek_id,
             status CHECK IN ('active','retired'), UNIQUE(project_id,version))
service_tokens(id PK, project_id, name, token_hash UNIQUE /*hex sha256*/, token_prefix,
               scope CHECK IN ('read','read_write'), environment_ids /*JSON, NULL=all*/,
               expires_at, last_used_at, revoked_at, created_by, created_at)
user_tokens(id PK, user_id, name, token_hash UNIQUE, token_prefix, expires_at, last_used_at, revoked_at, created_at)
instance_settings(key PK, value)   -- kek_check, allow_signup, bootstrapped_at
```

Token formats: `safe_st_<base64url(32B)>` / `safe_ut_<...>`; plaintext shown exactly once at creation; lookup by sha256.

## Redis key design (all values UTF-8 JSON, binary as base64)

```
secrets:{projectId}:{envId}                HASH  field=SECRET_KEY →
  { v, ct, nonce, tag, dekV, alg:"aes-256-gcm:v1", updatedAt, updatedBy }
secretver:{projectId}:{envId}:{key}        HASH  field=version int → (append-only)
  { ct, nonce, tag, dekV, alg, op:create|update|delete|rollback, actorType, actorId, ts, rollbackOf? }
secretvctr:{projectId}:{envId}:{key}       INCR  gap-free version counter
audit:{projectId} / audit:instance         STREAM  via send("XADD",...); read XREVRANGE + cursor on entry IDs
```

- Write path: MULTI/EXEC — INCR counter, HSET version, HSET current. Delete = HDEL current + tombstone version. **Rollback appends** (old ciphertext as version n+1, `op:"rollback"`) — history never rewritten; AAD excludes version so transplant within the same key is valid, while cross-key/env/project transplant fails AAD.
- AAD uses **ids not slugs** → env renames safe; secret key rename = delete+create (surface in UI copy).
- Audit untrimmed by default; `SAFE_AUDIT_MAXLEN` env → `XADD MAXLEN ~`. Log constants in `@safe/shared`: project/env/secret/member/token CRUD, `secrets.read` (bulk reveal/pull), auth.login/failed_login, dek.rotate, kek.rotate.

## API surface (Elysia, `/api`)

- `ALL /api/auth/*` — better-auth mount (opaque to Eden; web uses `better-auth/react` client for these).
- `GET /api/health` (redis PING, sqlite, KEK verified) · `GET /api/bootstrap` (`{needsSetup}` = zero users).
- Projects: GET list / POST (txn: project + default envs + DEK gen/wrap + creator admin membership) / GET :id / PATCH / DELETE (cascade + Redis UNLINK).
- Environments: POST / PATCH / DELETE under `/api/projects/:projectId/environments`.
- Secrets under `.../environments/:envId/secrets`:
  - `GET` keys+metadata; `?include_values=true` decrypts all + audits `secrets.read` (serves pull/run/reveal)
  - `PUT` bulk upsert `{secrets, prune?}` (serves push) · `PUT /:key` · `DELETE /:key`
  - `GET /:key/versions` (`?include_values=true` admin-only) · `POST /:key/rollback {toVersion}`
- Members: GET/POST/PATCH/DELETE (project admin). Service tokens: GET/POST (plaintext once)/DELETE (project admin).
- `GET /api/projects/:projectId/audit?cursor&limit&action&envId` · `POST /api/projects/:projectId/rotate-dek`.
- Personal tokens: `GET/POST/DELETE /api/me/tokens` (POST used by `/cli-auth` browser approve page).
- `GET /api/users` (instance admin — member picker).

**Principal middleware** (Elysia derive/macro): cookie session → user; `Bearer safe_ut_` → user via hash lookup; `Bearer safe_st_` → `{type:'service', projectId, scope, environmentIds}`. Guard `requireProjectRole(projectId, role)`; instance owner/admin ⇒ implicit project admin; service tokens never pass member/token/admin routes. Permission matrix = pure function in `@safe/shared`, unit-tested.

## CLI (`safe`)

```
safe login [--host URL] [--token PAT]   # loopback flow below; --token for headless
safe logout | whoami
safe init                                # pick/create project → writes .safe.json (host, project, projectId, defaultEnvironment); offers .gitignore append for .env
safe pull [-e env] [--out .env] [--format dotenv|json]
safe push [-e env] [--file .env] [--prune]
safe run  [-e env] -- <cmd...>           # Bun.spawn, env-injected, stdio inherit, forwards exit code; nothing on disk
safe secrets list|get K|set K V|rm K [-e env]
safe rotate dek [--project slug]
```

Login: CLI starts localhost server (random port, one-time state) → opens `https://<host>/cli-auth?redirect_port&state&name` → web (session-authed) approve → `POST /api/me/tokens` → redirect `http://127.0.0.1:<port>/callback?token&state` → CLI verifies state, writes `~/.config/safe/credentials.json` (0600, keyed by host). Resolution: token `SAFE_TOKEN` → credentials file; host `--host` → `.safe.json` → `SAFE_HOST` → credentials default. CLI is Bearer-only — no cookie handling anywhere.

## Docker / bootstrap

- Multi-stage Dockerfile (`oven/bun:1.3-alpine`): build web → runtime serves `web/dist` via `@elysiajs/static` (SPA fallback; `/api/*` precedence); non-root; HEALTHCHECK `/api/health`.
- compose: `app` (env: SAFE_MASTER_KEY required, BETTER_AUTH_SECRET, BETTER_AUTH_URL, REDIS_URL, SAFE_DB_PATH=/data/safe.db; volume safe-sqlite) + `redis:7-alpine --appendonly yes --appendfsync everysec` (volume safe-redis, healthcheck).
- `scripts/setup.sh`: writes `.env` with `openssl rand -base64 32` keys; loudly warns "back up SAFE_MASTER_KEY — losing it = losing all secrets".
- Boot: programmatic better-auth migrations (`getMigrations` from `better-auth/db`) + our SQL migrations → write/verify `kek_check`. Web `/setup` on `needsSetup`: first signup becomes instance owner, signup auto-disabled after (invitations thereafter).

## Testing strategy

- **Unit:** crypto (most important suite in the repo), permission matrix, dotenv codec, CLI config resolution, Redis JSON codecs.
- **API integration:** real Redis from `compose.test.yml` (no testcontainers dep), in-memory SQLite, `app.handle()` — no sockets; per-file key prefixes or dedicated DB index FLUSHDB.
- **Security-behavior tests (explicit):** AAD tamper (flip envId), cross-key ciphertext transplant, wrong-KEK boot abort, tombstone absent from pull, service-token env-scope crossing, audit entry on `include_values` reads.
- **CLI integration:** spawn api on random port, run CLI via `Bun.spawn` in temp dirs; assert `.env` bytes, injected child env, exit codes.
- **E2E thin:** Playwright smoke against built Docker image (CI).

## Risks / gotchas

1. better-auth migrations at boot: use programmatic `getMigrations`/`runMigrations`; pin the version (sqlite expectations shift between minors).
2. Eden type flow: export `App` from side-effect-free `app.ts`; type-only import in api-client; keep every plugin typed or the tree widens to `any`.
3. better-auth routes opaque to Eden — web auth via `better-auth/react` client only.
4. Bun.redis stream replies are RESP3-shaped (maps) — normalize in `redis/audit.ts`; test against real Redis, never mocks.
5. AOF everysec ⇒ ≤1s loss window on crash — document; `safe push` is idempotent.
6. SQLite ⇒ single app instance in v1 — document.
7. argon2id memory (~64MB/concurrent hash) — compose memory ≥512MB note.
8. OAuth callbacks need `BETTER_AUTH_URL` = public URL — setup.sh prompts for it.
9. Secret value size cap (64KB) + bulk payload caps at route schema level.
10. Redis volume backup docs (`redis-cli --rdb`) — SQLite alone cannot restore secrets; master key loss is total by design.

## Verification (end-to-end)

From a clean clone: `scripts/setup.sh && docker compose up` → browser `/setup` creates owner → create project → set secrets in web → `safe login` (loopback) → `safe init` → `safe pull` writes `.env` → `safe run -- env | grep KEY` shows injection → create read-only service token, `SAFE_TOKEN=… safe pull` in a clean shell works, push fails → check audit table shows the reads/writes → `docker compose restart` → data intact → KEK rotation script with swapped keys → secrets still decrypt. Plus `bun test` green at every phase boundary.

## Implementation deviations (sanctioned)

Where the shipped code intentionally departs from the design above:

1. **better-auth `admin` plugin instead of the `organization` plugin.** safe is a single-org instance; `user.role` (`owner`/`admin`/`member`) plus the admin create-user API covers the role model without unused org/invitation tables or an SMTP dependency.
2. **`GET /api/users` is open to all authenticated users** (not instance-admin only): the member picker needs the directory, and names/emails of co-workers on a private instance are not sensitive enough to gate.
3. **Single-secret read endpoint** `GET .../environments/:envId/secrets/:key` (with optional `?include_value=true`) was added so `safe secrets get K` doesn't decrypt the whole environment.
4. **`user_tokens.created_via` column** (`session` | `token`) records how a PAT was minted; token-minted PATs are lifetime-capped (≤30 days, never outliving the parent) and surfaced in the UI.
5. **`safe rotate dek --project <slug>`** lets the CLI target a project explicitly instead of requiring a `.safe.json` in the working directory.
