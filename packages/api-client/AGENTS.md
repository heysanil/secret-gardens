# @secret-gardens/api-client — agent guide

Typed Eden treaty client for the API. **Thin by design**: Eden's
`{ data, error, status }` shape passes through untouched — no retries, no
unwrapping, no error classes (those live in the consumers:
`apps/web/src/api.ts` and `apps/cli/src/lib/api.ts`). better-auth's
`/api/auth/*` endpoints are NOT covered here; the web app reaches them via
`better-auth/react`.

## Key files

- `src/index.ts` — `createApiClient({ baseUrl, token?, credentials?,
  fetcher? })`: Bearer header injection (CLI), cookie credentials (web),
  injectable fetch (tests), trailing-slash normalization. ~45 lines; it
  should stay near that size.
- `src/index.test.ts` — wiring tests with a stub fetcher AND the
  **compile-time `IsAny` guards**: if any plugin in the API's `createApp`
  loses its typing, the treaty client widens to `any` and these consts stop
  type-checking. Never loosen them to make a build pass — fix the typing
  loss in `apps/api`.

## Invariants

- **Stay thin.** No response transformation, no retry/backoff, no
  business logic. If a consumer needs behavior, it belongs in that consumer.
- **The dependency on `@secret-gardens/api` is type-only** (it sits in
  `devDependencies`; `import type { App }` only). Importing any runtime
  value from the API would drag the whole server (bun:sqlite, better-auth)
  into web/CLI bundles — never do it.
- `treaty<App>` keeps the explicit type argument so Eden's header generic
  stays at its default; don't switch to inference.
- Any-widening is a build failure by design (the `IsAny` consts, mirrored in
  `apps/api/src/app.test.ts`).

## Commands

```sh
cd packages/api-client && bun test    # stub-fetcher tests + type guards, no Redis
cd packages/api-client && bun run lint && bun run typecheck
```

## Update docs when you change…

The options shape (`ApiClientOptions`) → both consumers and their AGENTS.md
files. If typecheck starts failing here after API changes, the fix belongs
in `apps/api` (or `apps/web/src/types/server-types.d.ts` for ambient-type
gaps) — not in loosened guards. Root contract: root `AGENTS.md` §2.
