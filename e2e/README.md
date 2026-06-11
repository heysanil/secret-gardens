# secret-gardens e2e suite

Full-product Playwright tests: every web flow plus one real CLI↔browser
loopback login. They run against a real `apps/api` instance serving the
built web UI — no mocks anywhere.

## Prerequisites

1. **Redis** on port 6380 (the suite shares the integration-test redis, but
   under its own compose project name so it never collides with the deploy
   stack):

   ```sh
   docker compose -f compose.test.yml -p gardens-test up -d --wait
   ```

2. **Playwright chromium** (once per machine):

   ```sh
   cd e2e && bunx playwright install chromium
   ```

   Playwright's runner itself executes under Node (≥ 20 required on PATH);
   the server and the CLI under test run under Bun.

## Running

```sh
bun run test:e2e          # from the repo root
```

The suite is intentionally **not** part of `bun run test` (turbo's test
task) — it is slower, needs a browser, and owns global instance state.

## How the server is provisioned

`playwright.config.ts` declares a `webServer` that runs
`e2e/scripts/start-server.ts` with Bun. That script:

1. builds `@secret-gardens/web` if `apps/web/dist` is missing,
2. deletes and recreates a throwaway SQLite database (`e2e/.tmp/gardens-e2e.db`),
3. generates a fresh `GARDENS_MASTER_KEY` + `BETTER_AUTH_SECRET`, and
4. boots the real, unmodified API in-process on port 3179 with
   `REDIS_URL=redis://localhost:6380` and `GARDENS_WEB_DIST=apps/web/dist` —
   the production/docker topology, where the API serves the SPA itself.

> Static mode used to be broken (the static plugin's `GET /*` wildcard
> shadowed the mounted better-auth handler for GETs, so
> `GET /api/auth/get-session` 404ed and no browser session could exist) and
> the suite fronted the API with a static+proxy server as a workaround.
> That is fixed; `tests/13-static-mode.spec.ts` pins the regression against
> a dedicated static-mode instance.

A fresh database per run is what makes the suite repeatable: project ids
are new every run, so the shared redis db never needs flushing (its keys
are namespaced by project id), and the first-signup-becomes-owner flow in
`01-setup.spec.ts` always starts from a virgin instance.

## Ordering rationale

Bootstrap state is global per server instance, so the suite runs with
**one worker, no parallelism**, and the spec files are numbered to fix
their order:

- `01-setup` performs the one-and-only owner signup and saves the owner
  session to `e2e/.auth/owner.json`; every later file reuses that storage
  state. Run the whole suite (or at least 01 first) — individual files
  other than 01/02 assume the owner state file exists.
- `02-auth` drives the login form directly and only ever signs out
  sessions it created itself, so the saved owner state survives.
- `03`–`12` are self-contained beyond that: each creates its own
  uniquely-named project(s)/user(s) via the API, so one file failing does
  not cascade into the others.
