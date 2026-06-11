# @secret-gardens/shared — agent guide

Shared types, constants, the RBAC permission matrix, audit vocabulary, token
prefixes, dotenv codec, and validation rules. Consumed by the API, web UI,
and CLI. **Zero runtime dependencies** — keep it that way.

## Key files

- `src/roles.ts` — **`roleAllows` IS the authorization spec.** The
  `ROLE_PERMISSIONS` matrix (admin/write/read × six `ProjectAction`s),
  `serviceTokenAllows` (service tokens: own project only, `secrets.read`
  always, `secrets.write` iff `read_write` scope, env allow-list), and
  `resolveProjectRole` (instance owner/admin ⇒ implicit project admin).
- `src/principals.ts` — `UserPrincipal` / `ServicePrincipal` shapes.
- `src/tokens.ts` — `TOKEN_PREFIXES` (`sg_st_`, `sg_ut_`) + `classifyToken`.
- `src/audit.ts` — `AUDIT_ACTIONS` (the full vocabulary) and
  `PROJECT_AUDIT_ACTIONS` (excludes the instance-only `auth.login`,
  `auth.failed_login`, `kek.rotate`).
- `src/validation.ts` — secret key pattern `^[A-Za-z_][A-Za-z0-9_]*$`, max
  key length 256, max value 64 KiB, `MAX_BULK_SECRETS` 1000. The key pattern
  is also what keeps Redis `MATCH` patterns collision-free
  (`apps/api/src/redis/secretStore.ts`).
- `src/dotenv.ts` — dotenv parse/serialize used by CLI pull/push.
- `src/gardensConfig.ts` — `.gardens.json` schema (`parseGardensConfig`).
- `src/errors.ts` — shared error types (`GardensConfigError`).

## Invariants

- **Changes to `roles.ts` are SECURITY changes.** Every guard decision in
  `apps/api/src/auth/` ultimately reduces to this file. Widening a role's
  actions or `serviceTokenAllows` widens live access on every deployment —
  treat with the same rigor as a crypto change: tests first
  (`roles.test.ts` + `apps/api/src/routes/rbac.test.ts` /
  `serviceAccess.test.ts`), explicit review.
- `versions.read_values` belongs to **admin only** — historical values may
  hold secrets a rotated credential replaced.
- New audit actions go into `AUDIT_ACTIONS`; decide explicitly whether they
  are project-scoped (then they appear in `PROJECT_AUDIT_ACTIONS`
  automatically) or instance-only (then add them to the exclusion filter).
- Token prefixes are wire format: `classifyToken` drives Bearer routing in
  `apps/api/src/auth/principal.ts` and the CLI's service-token rejection in
  `login`. Changing a prefix invalidates every issued token.
- Validation limits are enforced server-side in `apps/api/src/routes/secrets.ts`
  — keep messages human-readable (they surface verbatim in the UI/CLI).

## Commands

```sh
cd packages/shared && bun test    # pure unit tests, no Redis needed
cd packages/shared && bun run lint && bun run typecheck
```

## Update docs when you change…

`roles.ts` → `docs/security.md` + root `AGENTS.md` §6; `audit.ts` → the web
project filter (`apps/web/src/pages/ProjectAuditPage.tsx`), the API
validation (`apps/api/src/routes/audit.ts`), `docs/self-hosting.md`;
`tokens.ts` → `docs/security.md` + the prefix-length call sites listed in
root `AGENTS.md` §2; validation limits → `README.md`/UI copy if user-facing.
Root contract: root `AGENTS.md` §2.
