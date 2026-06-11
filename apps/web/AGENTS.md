# @secret-gardens/web — agent guide

React 19 admin SPA: Vite + Tailwind 4, TanStack Query, react-router,
better-auth/react for sessions, Eden treaty client (cookie mode) for
everything else. In production the API serves `dist/` itself
(`GARDENS_WEB_DIST`); in dev Vite proxies `/api` → `:3000`
(`vite.config.ts`) and the API needs
`GARDENS_ADDITIONAL_ORIGINS=http://localhost:5173`.

## Key files

- `src/api.ts` — the ONE treaty client, `unwrap()` (Eden → `ApiError`,
  401 → login redirect), the `FRIENDLY` error-code → message map, and
  **`keys` — the query-key vocabulary for the whole app**. Every query key
  comes from `keys.*`; never hand-roll key arrays in pages.
- `src/queries.ts` — cross-route fetchers/hooks only; page-specific queries
  stay colocated with their pages.
- `src/auth.ts` — better-auth client; `src/gates.tsx` — BootstrapGate /
  RequireSession / `safeNextPath` (open-redirect guard).
- `src/lib/cliAuth.ts` — the FIXED `/cli-auth` querystring contract with the
  CLI loopback server (see `apps/cli/src/lib/loopback.ts`).
- `src/pages/secrets/` — SecretsTable owns the decrypted-values query
  (`keys.secretValues`); `src/components/TokenReveal.tsx` — show-once token UI.
- `src/types/server-types.d.ts` — ambient typing bridge so the Bun-flavored
  `App` type checks under the browser tsconfig. Touch only if api imports
  start failing typecheck.

## Invariants

- **Secret-value cache hygiene**: decrypted values live under
  `keys.secretValues(projectId, envId)` and nowhere else. On environment
  delete, `removeQueries` that exact key
  (`pages/settings/EnvironmentsSection.tsx`); on project delete,
  `removeQueries({queryKey: ["secret-values", projectId]})`
  (`pages/settings/DangerZoneSection.tsx`). Plaintext of deleted data must
  not linger in the heap. Any new surface that caches values must follow
  the same rule.
- **Show-once lifecycle**: minted token plaintext exists only in the create
  mutation's response → `TokenReveal` → gone on modal close. Never put it in
  a query cache, never refetch it (the server can't return it again).
- **`data-testid` attributes are an e2e contract.** The Playwright suite
  selects on them; never rename/remove one without updating `e2e/tests/`
  in the same commit (grep e2e for the id first).
- New API error codes need a `FRIENDLY` entry in `src/api.ts` (root
  AGENTS.md §2 matrix).
- The project audit filter renders `PROJECT_AUDIT_ACTIONS` (not
  `AUDIT_ACTIONS`) — instance-only actions must not appear
  (`pages/ProjectAuditPage.tsx`).
- better-auth is exact-pinned `1.6.16` here and in `apps/api` — bump both
  together.

## Commands

```sh
cd apps/web && bun run dev        # Vite :5173 (API must be running on :3000)
cd apps/web && bun test           # browser-free unit tests (lib/, bun:test)
cd apps/web && bun run typecheck  # tsc app config + tsconfig.test.json
cd apps/web && bun run lint
cd apps/web && bun run build      # vite build → dist/ (what the API serves)
```

UI behavior is covered by the e2e suite, not unit tests — run
`bun run test:e2e` from the repo root after UI changes (see `e2e/AGENTS.md`).

## Update docs when you change…

Error handling / codes → `FRIENDLY` map + root AGENTS.md §5 inventory;
`/cli-auth` contract → `apps/cli` loopback + e2e test 10; testids → e2e
specs; query keys or cache hygiene → this file. Root contract: root
`AGENTS.md` §2.
