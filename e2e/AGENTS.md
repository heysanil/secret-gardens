# @secret-gardens/e2e — agent guide

Full-product Playwright suite: every web flow plus a real CLI↔browser
loopback login, against a real `apps/api` instance serving the built web UI
— **no mocks anywhere**. Deliberately excluded from `bun run test` (slower,
needs a browser, owns global instance state). See `e2e/README.md` for the
long-form rationale; keep the two files in sync.

## Running

```sh
docker compose -f compose.test.yml -p gardens-test up -d --wait  # Redis :6380
cd e2e && bunx playwright install chromium                       # once per machine
bun run test:e2e                                                 # from the repo root
```

The Playwright runner itself executes under Node (≥ 20 on PATH); the server
and the CLI under test run under Bun. The `-p gardens-test` project name
keeps the test Redis from colliding with the deploy stack (root AGENTS.md §4).

## Server provisioning

`playwright.config.ts` declares a `webServer` running
`scripts/start-server.ts`, which: builds `apps/web/dist` if missing, wipes
and recreates `e2e/.tmp/gardens-e2e.db`, generates a fresh
`GARDENS_MASTER_KEY` + `BETTER_AUTH_SECRET`, refuses to start if port 3179
is taken (SO_REUSEPORT would silently share it with a stray server), and
boots the real API in-process on **port 3179** with
`REDIS_URL=redis://localhost:6380` and `GARDENS_WEB_DIST=apps/web/dist` —
the production/static topology. A fresh DB per run is what makes the suite
repeatable: project ids are new each run, so the shared Redis never needs
flushing.

## Serial ordering (do not parallelize)

Bootstrap state (first-signup-becomes-owner) is global per server instance,
so: **one worker, `fullyParallel: false`, spec files numbered `01`–`13`**.

- `01-setup` performs the one-and-only owner signup and saves the session to
  `e2e/.auth/owner.json`; every later file reuses that storage state.
- `02-auth` drives the login form and only signs out sessions it created.
- `03`–`12` are self-contained beyond the owner state: each provisions its
  own uniquely-named projects/users via `helpers/api.ts`.
- `13-static-mode` boots a dedicated second instance (port 3182) pinning the
  static-serving route-precedence regression (root AGENTS.md §8).

Run the whole suite, or at least `01` before any individual later file.

## Helpers

- `helpers/api.ts` — API seeding over Playwright request contexts
  (`newOwnerContext`, `newBearerContext`, createProject/putSecret/createUser/
  addMember/createPat…). better-auth cookie POSTs need an `Origin` header —
  the owner context sets it.
- `helpers/constants.ts` — BASE_URL, OWNER_STATE path, passwords.
- `helpers/ui.ts` — shared UI interaction helpers.

## Invariants / update docs when you change…

- Tests select on `data-testid` — those ids are a contract with
  `apps/web` (see `apps/web/AGENTS.md`); update both sides together.
- New specs: keep the numeric prefix ordering and the self-containment rule
  (provision your own data via helpers; never depend on another spec's
  project).
- Changing ports (3179/3182), the Redis URL, or provisioning steps → update
  `playwright.config.ts`, `scripts/start-server.ts`, `e2e/README.md`, and
  this file together. Root contract: root `AGENTS.md` §2.
