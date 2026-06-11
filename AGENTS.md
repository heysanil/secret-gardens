# secret-gardens — agent guide

## 1. Project overview

secret-gardens is a self-hosted, open-source secrets manager (AGPL-3.0-only).
Teams store secrets per project/environment, manage them in a React admin UI,
and pull/push/inject them with the `gardens` CLI — including in CI via scoped
service tokens.

- **Runtime/stack**: Bun monorepo (turbo + Biome). API = Elysia; auth =
  better-auth; web = React 19 + Vite + TanStack Query + Tailwind; CLI = citty.
- **Storage split**: Redis holds only ciphertext (secrets, versions) and audit
  streams; SQLite (bun:sqlite) holds better-auth tables, project/env/member
  metadata, token hashes, and **wrapped** per-project DEKs.
- **Crypto**: envelope encryption — env-var KEK (`GARDENS_MASTER_KEY`) →
  HKDF-derived wrapping key → per-project DEK → AES-256-GCM per secret with
  AAD `projectId:envId:secretKey`. Implemented in `packages/crypto` on
  `node:crypto` only.
- **Self-hosting**: `scripts/setup.sh` + `docker-compose.yml` (one app
  container serving API + built web UI, one Redis container).

## 2. ⚠️ DOCUMENTATION MAINTENANCE CONTRACT (BINDING)

> **Every change MUST be accompanied by the matching documentation updates in
> the same commit.** A commit or PR that changes behavior without the doc
> delta is incomplete and must not be merged.

The required loop:

1. **Before starting**: read the `AGENTS.md` of every directory you will
   touch (each workspace has one; this file covers the repo root).
2. **Before committing**: re-check whether your change invalidates ANY
   statement in:
   - the touched directories' `AGENTS.md`,
   - this root `AGENTS.md` (especially the route inventory, commands, and
     gotchas below),
   - `README.md`,
   - `docs/self-hosting.md` (the **env var table** especially),
   - `docs/security.md` (crypto and token-format claims),
   - `e2e/README.md`.
3. **Update them in the same commit.** Doc drift is worse than no docs:
   agents and humans act on these files verbatim.
4. When adding env vars / routes / CLI commands / error codes / audit actions,
   update the specific targets in the matrix below.

### Doc-update matrix — "if you change X, you must update Y"

| If you change… | …you must update |
|---|---|
| Env vars (`apps/api/src/config.ts`) | `docker-compose.yml`, `scripts/setup.sh`, the env table in `docs/self-hosting.md`, `docker/Dockerfile` (ENV defaults), `e2e/scripts/start-server.ts`, and the Commands section below |
| API routes or error codes (`apps/api/src/routes/*`, `apps/api/src/app.ts`) | the `FRIENDLY` map in `apps/web/src/api.ts`, the error mapping in `apps/cli/src/lib/api.ts`, and this file's route inventory (§5) |
| Add/change an API route | the route MUST include `detail` metadata (summary/description/tags; `security: []` if public) — `apps/api/src/openapi.test.ts` fails without it — and the OpenAPI `info.description` in `apps/api/src/openapi.ts` must be updated whenever error codes or auth semantics change (its error table mirrors §5) |
| CLI commands/flags (`apps/cli/src/commands/*`) | the CLI table in `README.md` and `apps/cli/AGENTS.md` |
| Crypto scheme details (`packages/crypto`) | `docs/security.md`. **HARD WARNING:** the label strings are data-compatibility-critical — `secret-gardens/v1/dek-wrap` (HKDF info, `masterKey.ts`), `secret-gardens-dek:` (DEK AAD prefix, `dek.ts`), `secret-gardens-kek-check-v1` (boot-check constant, `apps/api/src/services/kekCheck.ts`), `aes-256-gcm:v1` (record `alg`, `apps/api/src/services/secretService.ts`). Changing any of them **bricks existing deployments' data**: previously wrapped DEKs and stored ciphertext stop authenticating. They are frozen; never "tidy" or rename them. |
| Audit actions (`packages/shared/src/audit.ts`) | the project filter in `apps/web/src/pages/ProjectAuditPage.tsx` (`PROJECT_AUDIT_ACTIONS`), the `KNOWN_ACTIONS` validation in `apps/api/src/routes/audit.ts`, and `docs/self-hosting.md` |
| Token formats (`packages/shared/src/tokens.ts`) | `docs/security.md`, the `TOKEN_DISPLAY_PREFIX_LEN` math in `apps/api/src/routes/tokens.ts`, `apps/api/src/routes/me.ts`, and `apps/cli/src/commands/logout.ts` (all assume prefix + 6 chars = 12), and the `tokenPrefix` display in `apps/web/src/pages/AccountTokensPage.tsx` / `apps/web/src/pages/settings/ServiceTokensSection.tsx` |
| Workspaces (`package.json` `workspaces`) | the manifest `COPY` blocks in `docker/Dockerfile` — **both stages**. A missing workspace `package.json` fails `bun install --frozen-lockfile` with an opaque lockfile error that names no file |
| better-auth version | it is **exact-pinned to `1.6.16` in TWO package.jsons** — `apps/api/package.json` and `apps/web/package.json` — and must move in lockstep, plus `apps/api/AGENTS.md` / the gotcha in §8 |

## 3. Repository map

| Path | Purpose | Agent docs |
|---|---|---|
| `apps/api/` | Elysia API server: auth guards, routes, secret/DEK services, Redis + SQLite storage, KEK tooling | `apps/api/AGENTS.md` |
| `apps/web/` | React admin SPA (Vite, TanStack Query, Tailwind, better-auth/react) | `apps/web/AGENTS.md` |
| `apps/cli/` | `gardens` CLI (citty): login/pull/push/run/secrets/rotate | `apps/cli/AGENTS.md` |
| `packages/crypto/` | Envelope-encryption primitives, zero deps | `packages/crypto/AGENTS.md` |
| `packages/shared/` | Shared types, RBAC matrix, audit vocabulary, token prefixes, dotenv codec, validation | `packages/shared/AGENTS.md` |
| `packages/api-client/` | Typed Eden treaty client (thin) | `packages/api-client/AGENTS.md` |
| `e2e/` | Playwright full-product suite (serial, 01–13) | `e2e/AGENTS.md` |
| `docker/` | `Dockerfile` (two-stage: web build → Bun runtime serving API + SPA) | — |
| `scripts/` | `setup.sh` (generate `.env`), `build-cli.sh` (compile CLI binaries) | — |
| `docs/` | `self-hosting.md`, `security.md`, `superpowers/specs/` (historical) | — |

## 4. Commands

All verified against `package.json` / turbo. **Always use Bun** (§7).

```sh
bun install                      # workspace install (bun@1.3.5 pinned)

bun run lint                     # bunx turbo run lint (Biome)
bun run typecheck                # bunx turbo run typecheck (tsc --noEmit per workspace)
bun run test                     # bunx turbo run test --filter=!@secret-gardens/e2e
bun run build                    # bunx turbo run build (only web emits output: dist/)
```

**Test prerequisite — integration Redis on :6380** (api + cli test suites
fail fast in their bun:test preload without it):

```sh
docker compose -f compose.test.yml -p gardens-test up -d --wait
```

Why `-p gardens-test`: compose derives its default project name from the
checkout directory (this checkout is `safe`), which the **deploy** stack
(`docker compose up`) also uses — without `-p`, the test Redis and the deploy
stack would share one compose project and clobber each other. Tests connect
to `redis://localhost:6380` either way (`REDIS_TEST_URL` overrides).

**E2E** (not part of `bun run test`; needs the same test Redis, plus
chromium via `cd e2e && bunx playwright install chromium`, and Node ≥ 20 on
PATH for the Playwright runner):

```sh
bun run test:e2e                 # bun run --cwd e2e test → playwright test
```

**Dev servers**:

```sh
# API on :3000 — needs GARDENS_MASTER_KEY (base64 32 bytes), BETTER_AUTH_SECRET
# (≥32 chars) and a reachable Redis (default redis://localhost:6379).
# Serves its OpenAPI docs at /docs (Scalar UI) and /docs/json (spec):
cd apps/api && bun --watch src/index.ts

# Web on :5173 (Vite proxies /api → :3000). The API must also have
# GARDENS_ADDITIONAL_ORIGINS=http://localhost:5173 set or better-auth
# rejects the dev origin:
cd apps/web && bun run dev
```

**Self-hosting / Docker**:

```sh
scripts/setup.sh                 # writes .env (GARDENS_MASTER_KEY, BETTER_AUTH_SECRET, URLs)
docker compose up -d --build     # build + run app (API serving built web UI) + Redis
```

**CLI binaries**: `scripts/build-cli.sh` compiles
`dist/cli/gardens-bun-{linux,darwin}-{x64,arm64}` via `bun build --compile`
and smoke-tests the native one.

**KEK rotation** (`apps/api/scripts/rotate-kek.ts` — re-wraps every project
DEK + the kek_check in one SQLite transaction; Redis ciphertext untouched):

```sh
docker compose run --rm \
  -e GARDENS_MASTER_KEY_NEW="$(openssl rand -base64 32)" \
  app bun apps/api/scripts/rotate-kek.ts
# or directly: GARDENS_MASTER_KEY=… GARDENS_MASTER_KEY_NEW=… \
#   GARDENS_DB_PATH=./data/gardens.db bun apps/api/scripts/rotate-kek.ts
# REDIS_URL optional — enables the best-effort kek.rotate audit entry.
```

## 5. Architecture invariants (do not violate)

- **`packages/crypto` is the ONLY place that touches `node:crypto`
  encryption primitives.** It has zero runtime dependencies and no IO.
- **`apps/api/src/services/secretService.ts` is the ONLY
  encryption/decryption boundary.** Below it (secretStore, Redis) only opaque
  ciphertext exists; above it (routes) only plaintext. Server-side plaintext
  exists nowhere else.
- **Authorization flows exclusively through the guards in
  `apps/api/src/auth/`** — the `requireAuth` / `requireInstanceAdmin` /
  `requireProject` / `requireProjectAction` Elysia macros in `principal.ts` +
  `projectGuard.ts` — backed by the pure matrix in
  `packages/shared/src/roles.ts` (`roleAllows`, `serviceTokenAllows`,
  `resolveProjectRole`). **Never inline permission logic in routes.**
- **Storage split**: Redis = ciphertext + version history + audit streams;
  SQLite = better-auth tables, metadata, wrapped DEKs (`project_keys`).
- **Redis multi-key writes are single Lua scripts (EVAL) only — never
  MULTI/EXEC.** Bun's RedisClient shares one auto-pipelined connection;
  interleaved transactions from concurrent requests would corrupt each other
  (see `apps/api/src/redis/secretStore.ts`).
- **AAD uses ids, never slugs** (`projectId:envId:secretKey`) so renames stay
  safe. Consequently **ids must never contain `:`** — enforced by
  `apps/api/src/db/ids.ts` (`newId`); keep it that way.
- **History is append-only.** Rollback appends a new version that reuses the
  target's ciphertext verbatim (valid because AAD excludes the version
  number); nothing ever rewrites or deletes version records, except DEK
  rotation's `rewriteCurrent`, which swaps ciphertext fields of the CURRENT
  record in place without touching history.
- **SQLite migrations are append-only** (`apps/api/src/db/migrations.ts`):
  never edit an applied migration; add a new one.

### Route inventory (update on any route change — see §2)

Public: `GET /api/health`, `GET /api/bootstrap`, `GET /docs` (Scalar OpenAPI
UI) + `GET /docs/json` (OpenAPI spec — both deliberately unauthenticated,
`apps/api/src/openapi.ts`). better-auth owns `/api/auth/*` (mounted; sign-up
gated by `allow_signup`, sign-in wrapped for failed-login auditing in
`apps/api/src/app.ts`). Authenticated:

- `GET /api/me`; `GET|POST /api/me/tokens`; `DELETE /api/me/tokens/:id`
- `GET /api/users`
- `GET|POST /api/projects`; `GET|PATCH|DELETE /api/projects/:projectId`;
  `POST /api/projects/:projectId/rotate-dek`
- `POST /api/projects/:projectId/environments`;
  `PATCH|DELETE …/environments/:envId` (no list route — env lists ride on
  project detail; env slugs are immutable)
- `GET|POST /api/projects/:projectId/members`;
  `PATCH|DELETE …/members/:userId`
- `GET|POST /api/projects/:projectId/tokens`; `DELETE …/tokens/:tokenId`
- `GET /api/projects/:projectId/audit`
- Secrets under `…/environments/:envId/secrets`: `GET /`, `GET /:key`,
  `PUT /` (bulk), `PUT /:key`, `DELETE /:key`, `GET /:key/versions`,
  `POST /:key/rollback`

Error codes in use (machine `error` field): `unauthorized`, `forbidden`,
`not_found`, `invalid_token`, `signup_disabled`, `duplicate_slug`,
`invalid_slug`, `already_member`, `last_admin`, `invalid_key`,
`invalid_value`, `invalid_secrets`, `too_many_secrets`,
`invalid_environment_ids`, `invalid_action`, `invalid_cursor`,
`invalid_limit`, `cannot_rollback_to_delete`, `parent_token_expired`,
`decrypt_failed`, `internal_error`.

## 6. Security invariants (must never regress)

- **404, not 403, for non-members.** A user without access to a project (or
  a service token probing any project but its own) gets `404 not_found` —
  never reveal which project ids exist (`apps/api/src/auth/projectGuard.ts`).
- **Token plaintext is show-once.** The create responses in
  `apps/api/src/routes/tokens.ts` / `me.ts` are the only places plaintext
  tokens appear; the UI shows them once (`apps/web/src/components/TokenReveal.tsx`).
- **Tokens are stored as SHA-256 hashes only** (`token_hash`), plus a
  12-char display prefix. Lookups hash the presented token
  (`apps/api/src/auth/principal.ts`).
- **Service tokens are limited to `secrets.read` / `secrets.write` plus a
  filtered project-detail read** (`project.read` exception so CI can resolve
  env slugs → ids). They never get versions, audit, members, or token routes
  (`packages/shared/src/roles.ts` `serviceTokenAllows` +
  `projectGuard.ts` `ServiceAccessSpec`).
- **No secret values in audit fields, logs, or error messages.** Audit
  entries record keys/counts, never values. `DecryptFailedError`
  (`apps/api/src/services/secretService.ts`) deliberately drops its cause
  and identifies records by location only; routes map it to
  `500 decrypt_failed`.
- **`versions.read_values` (historical plaintext) is project-admin-only**
  (`apps/api/src/routes/secrets.ts` versions route).
- **Instance-only audit actions** (`auth.login`, `auth.failed_login`,
  `kek.rotate`) are excluded from `PROJECT_AUDIT_ACTIONS` and must never
  appear in the project filter UI (`packages/shared/src/audit.ts`).
- **Signup auto-closes after bootstrap.** The first user atomically claims
  ownership (`claimInstanceOwnership` in `apps/api/src/auth/index.ts` — a
  self-arbitrating UPDATE), which flips `allow_signup` off; the gate lives in
  `apps/api/src/app.ts`.
- Bulk value reads (`?include_values=true`) always append a `secrets.read`
  audit entry with the actor.

## 7. Conventions

- **Bun only.** Never invoke `npm`, `yarn`, or `node` directly; scripts run
  under `bun` / `bunx` (exception: Playwright's own runner uses Node
  internally — that's expected).
- **TypeScript strict** + `noUncheckedIndexedAccess` (`tsconfig.base.json`).
  All workspaces typecheck with `tsc --noEmit`; nothing emits JS (the web
  builds via Vite, the CLI compiles via `bun build --compile`).
- **Biome** for lint + format: 2-space indent, organize-imports assist,
  `vcs.useIgnoreFile` (root `biome.json`; `apps/web/biome.json` adds
  Tailwind directives).
- **Tests colocated** as `*.test.ts` next to sources, using `bun:test`.
  Integration tests run against the **real** test Redis (no mocks of the
  storage layer); `apps/api/bunfig.toml` / `apps/cli/bunfig.toml` preloads
  fail fast when it is down. TDD is expected for new behavior.
- **Conventional commits** (`feat:`, `fix(scope):`, `chore:`, `docs:` …).
- **Commits and PRs must NEVER contain AI/agent attribution of any kind** —
  no `Co-Authored-By` bot lines, no "Generated by …" footers.
- **Naming family**: `GARDENS_*` env vars, `sg_st_` / `sg_ut_` token
  prefixes, `.gardens.json` project config, `~/.config/gardens/credentials.json`
  CLI credentials, `gardens` CLI binary, `@secret-gardens/*` package scope.

## 8. Known gotchas

- **`bun.lock` only rewrites when the dependency graph changes.** Pure
  metadata edits (e.g. renaming a workspace's `name`) do not trigger a
  rewrite on `bun install` — edit the lockfile entry manually or the
  Dockerfile's `--frozen-lockfile` install fails (see commit `cff2da1`).
- **better-auth is exact-pinned at `1.6.16`** in `apps/api` AND `apps/web`
  (lockstep — see §2). The API imports internal paths
  (`better-auth/db/migration`, `better-auth/plugins/admin/access`) that can
  move between versions; bump deliberately, run the full suite.
- **Eden type flow**: the `App` type comes from the side-effect-free
  `createApp` in `apps/api/src/app.ts` (re-exported as a type from
  `index.ts`); `packages/api-client` imports it **type-only**. Any plugin in
  `createApp` losing its typing silently widens the treaty client to `any` —
  the `IsAny` compile-time guards in `packages/api-client/src/index.test.ts`
  and `apps/api/src/app.test.ts` exist to catch exactly that. Don't "fix"
  them by loosening.
- **Static serving is route-precedence-sensitive**
  (`apps/api/src/staticWeb.ts`): `@elysiajs/static` must stay in
  `alwaysStatic: true` mode (explicit per-file routes), and the SPA-fallback
  `GET /*` must keep forwarding unmatched `/api` GETs to `auth.handler` — a
  plain wildcard shadows the mounted better-auth `ALL /*` for GETs and kills
  `GET /api/auth/get-session` (history pinned by `e2e/tests/13-static-mode.spec.ts`).
- **Compose project names**: the deploy stack's project name comes from the
  checkout directory; always run the test Redis under `-p gardens-test`
  (§4) so the stacks never collide.
- **Test Redis port 6380 is hardcoded** (host side): `compose.test.yml` maps
  6380→6379; `apps/{api,cli}/test/testRedis.ts` and the e2e scripts default
  to `redis://localhost:6380`.
- **argon2id parameters are deliberately OWASP-sized** — `memoryCost: 19456`
  KiB, `timeCost: 2` (`apps/api/src/auth/index.ts`), NOT Bun's 64 MiB
  default, so a small self-hosted container survives concurrent hashes.
- **The e2e suite is serial and order-dependent** — one worker, specs
  numbered `01`–`13`; `01-setup` creates the instance owner whose storage
  state later files reuse. See `e2e/AGENTS.md`.

## 9. Historical docs note

`docs/superpowers/specs/2026-06-10-safe-secrets-manager-design.md` is the
**pre-rename** design spec (the project was renamed safe → secret-gardens; a
banner at the top says so). It is kept as written: do **not** copy
identifiers, env var names, token prefixes, or paths from it — use the
current code and the docs in `docs/` instead.
