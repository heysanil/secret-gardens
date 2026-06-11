# @secret-gardens/api — agent guide

Elysia API server. Boot order (`src/index.ts`): config → SQLite →
better-auth migrations → our migrations → KEK boot-check → Redis → listen.
`src/app.ts` (`createApp`) is the side-effect-free composition root — no
listening, no env reads — so tests and Eden type extraction can import it.

## Key files

- `src/config.ts` — all env parsing (`loadConfig`); never echoes secret values.
- `src/auth/index.ts` — better-auth wiring (admin plugin = instance roles),
  argon2id params (19456 KiB, t=2 — deliberate, not Bun's default), atomic
  `claimInstanceOwnership` (first signup → owner, signup closes).
- `src/auth/principal.ts` — principal resolution (Bearer `sg_ut_`/`sg_st_`
  via sha256 lookup, else cookie session) + the four guard macros.
- `src/auth/projectGuard.ts` — `resolveProjectAccess`: the 404-vs-403 rules.
- `src/db/` — `openDb` (WAL, FKs, busy_timeout), append-only `migrations.ts`,
  `newId` (ids must never contain `:` — they sit in Redis keys and AAD).
- `src/redis/secretStore.ts` — ciphertext-only storage; Lua-script writes.
- `src/redis/audit.ts` — XADD/XREVRANGE audit streams (`audit:{projectId}`,
  `audit:instance`).
- `src/services/dekService.ts` — wrapped-DEK rows + in-memory DEK cache.
- `src/services/secretService.ts` — THE encryption boundary (see root §5).
- `src/services/kekCheck.ts` / `kekRotation.ts` + `scripts/rotate-kek.ts` —
  KEK fingerprint boot-check and rotation.
- `src/openapi.ts` — `@elysiajs/openapi` plugin config: Scalar UI at
  `GET /docs`, spec at `GET /docs/json` (both public), the long markdown
  `info.description`, tags, security schemes, and the route-path excludes
  (exact-string only in plugin 1.4 — regexes silently do nothing).
  `API_VERSION` is hardcoded and test-pinned to package.json.
- `src/routes/errorSchemas.ts` — shared 401/403/404/500 response schemas
  for route `response` maps.
- `src/elysiaBehavior.test.ts` — characterization tests pinning elysia's
  response-schema runtime semantics (see the invariant below).
- `src/staticWeb.ts` — serves the built SPA; route-precedence-sensitive
  (root AGENTS.md §8).
- `test/testApp.ts` — integration harness (in-memory SQLite + real Redis);
  `test/testRedis.ts` → `redis://localhost:6380`; `bunfig.toml` preload
  fails fast when the test Redis is down.

## Invariants

- **Every route MUST ship `detail` metadata** — `summary`, a genuinely
  useful `description` (semantics, side effects, error cases), `tags` from
  the tag set in `src/openapi.ts`, and `security: []` for public routes.
  `src/openapi.test.ts` fails any operation missing them, and its
  `PUBLIC_PATHS` allowlist must be updated in the same change when a route
  is made public — both directions are asserted (public without the
  override, and an override without an allowlist entry, each fail).
- **Runtime `response` schemas: validated, and conditionally
  status-rewriting** (observed on elysia 1.4.28; pinned by the
  characterization tests in `src/elysiaBehavior.test.ts` — if an elysia
  upgrade fails them, re-verify and rewrite this invariant). DECLARED
  statuses are runtime-validated (mismatched body → 422 response-validation
  error) and keep their codes. An UNDECLARED status returned via
  `status(...)` keeps its code — EXCEPT when the map declares only a 200
  (single-entry `{200}` map, or the shorthand `response: schema`) AND the
  handler source never references `set`: then the response is **silently
  rewritten to HTTP 200** with the body kept (Elysia's AOT inspects the
  handler source for `set` usage). Multi-status maps always preserve
  status. Guard/macro early-returns, thrown errors, and `onError` responses
  bypass response validation entirely and keep their statuses. In practice:
  declare every status a handler can produce (tsc rejects undeclared
  `status()` returns; keep `set.status` writes pointed at declared
  statuses, and never cast around the response type). For shapes a schema
  can't honestly express (unions on principal type, free-form audit
  fields), use doc-only `detail.responses` instead — but never both on one
  route: a runtime map resets `detail.responses` in the generated spec.
- **Guards only.** Every route's authz is one of `requireAuth`,
  `requireInstanceAdmin`, `requireProject: minRole`, or
  `requireProjectAction: {minRole, serviceAction}`. Never inline permission
  checks; never re-derive roles in handlers.
- **`projectRole` is `null` for service principals** under
  `requireProjectAction`. Never synthesize a role from a token scope and
  feed it to `roleAllows` — that grants permissions the token must not have.
  Handlers needing a role must handle `null`.
- **404-not-403**: non-members and service tokens probing foreign projects
  get `not_found`, never `forbidden`.
- **Multi-key Redis writes are single Lua scripts (EVAL), never MULTI/EXEC**
  — Bun's RedisClient auto-pipelines one shared connection.
- **`:envId` must be validated to belong to the project** (404 otherwise)
  before any secret operation — `findEnvId` in `routes/secrets.ts`.
- **Audit pattern**: mutate first, then `audit.appendAudit` with string-only
  fields (keys/ids/counts — never secret values). Bulk value reads append
  `secrets.read`. Project-scoped events go to `{projectId}`; instance events
  (token.create for PATs, project.create/delete, dek.rotate, auth.*) also or
  only to `"instance"`.
- **Migrations are append-only**; columns referencing better-auth's `user`
  table are plain TEXT (no FK — `user` is created later in boot order).
- **`DecryptFailedError` drops its cause** and routes map it to
  `500 {error:"decrypt_failed"}` via `.onError` (secrets + projects routes).
- DEK cache buffers are shared by reference — **never zero them**
  (`fill(0)`); see the ownership contract in `packages/crypto`.

## Commands

```sh
docker compose -f compose.test.yml -p gardens-test up -d --wait  # test Redis :6380
cd apps/api && bun test          # integration tests (real Redis, no mocks)
cd apps/api && bun run lint && bun run typecheck
cd apps/api && bun --watch src/index.ts   # dev server (needs GARDENS_MASTER_KEY,
                                          # BETTER_AUTH_SECRET, local Redis)
```

## Update docs when you change…

Per the root contract (root `AGENTS.md` §2): env vars → compose/setup.sh/
self-hosting table/Dockerfile/e2e start-server; routes or error codes → web
`FRIENDLY` map, CLI error mapping, root route inventory, AND the OpenAPI
error table in `src/openapi.ts` (`info.description`); new routes → `detail`
metadata (first invariant above); audit actions → shared/audit.ts consumers;
anything crypto-adjacent → `docs/security.md`. better-auth version moves in
lockstep with `apps/web`.
