# @secret-gardens/cli — agent guide

The `gardens` CLI (citty). Bearer-only client of the API: it authenticates
with `Authorization: Bearer sg_ut_…` (PATs) or `sg_st_…` (service tokens via
`GARDENS_TOKEN`) — **never cookies**. Commands are thin; resolution logic is
centralized.

## Key files

- `src/index.ts` — command registry (`login`, `logout`, `whoami`, `init`,
  `pull`, `push`, `run`, `secrets`, `rotate`). Changing commands/flags? See
  the doc reminder below.
- `src/lib/context.ts` — **the single resolution point** for host, token,
  `.gardens.json` discovery (walks up from cwd like git), and env-slug → id
  resolution. Precedence lives here and ONLY here:
  host = `--host` → `.gardens.json` → `GARDENS_HOST` → credentials
  defaultHost; token = `GARDENS_TOKEN` → stored credentials.
- `src/lib/credentials.ts` — `${XDG_CONFIG_HOME ?? ~/.config}/gardens/credentials.json`,
  0700 dir / 0600 file, atomic write (temp + rename). Corrupt file = loud
  error, never silently empty.
- `src/lib/loopback.ts` — browser login: one-shot 127.0.0.1 server. The
  querystring contract with the web `/cli-auth` page is **FIXED** (see
  `apps/web/src/lib/cliAuth.ts`): open
  `${host}/cli-auth?redirect_port&state&name`, receive
  `GET /callback?token&tokenId&state`. Single-use `state` nonce.
- `src/lib/api.ts` — Eden unwrap → friendly `CliError`s; 422 details name
  offending KEYS only, never values.
- `src/lib/errors.ts` — `CliError` (message to stderr, no stack, exit code).
- `test/harness.ts` + `test/integration.test.ts` — real API child process +
  real CLI child processes; needs the test Redis (`test/testRedis.ts`,
  :6380; `bunfig.toml` preload checks it).

## Invariants

- **Secret values reach stdout in exactly two places**: `pull --out -` and
  `secrets get`. Everything else prints summaries to **stderr** (stdout may
  be carrying the secrets). `run` injects values into the child env only —
  never disk, never the CLI's own stdio.
- `pull` writes files with mode 0600 on creation; output is key-sorted for
  stable diffs.
- `secrets get` uses the single-key endpoint so the server audits a targeted
  read, not a bulk one.
- `login --token` rejects service tokens (`sg_st_`) — those belong in
  `GARDENS_TOKEN`, not the credentials store.
- `logout` revokes server-side best-effort (by stored tokenId, else by
  12-char prefix match), then always removes local credentials.
- `run` forwards the child's exit code exactly; signal deaths exit `128+n`.
- Expected failures are `CliError` only; anything else is a bug surfacing.

## Commands

```sh
docker compose -f compose.test.yml -p gardens-test up -d --wait  # test Redis :6380
cd apps/cli && bun test          # includes the real-API integration suite
cd apps/cli && bun run lint && bun run typecheck
bun apps/cli/src/index.ts --help # run from a checkout
scripts/build-cli.sh             # compile dist/cli/gardens-<target> binaries
```

## Update docs when you change…

Commands or flags → the CLI table in `README.md` and this file. The loopback
querystring contract → `apps/web/src/lib/cliAuth.ts` + its tests +
`e2e/tests/10-cli-auth.spec.ts` (change all sides together or logins break).
Credentials/`.gardens.json` shape → `packages/shared/src/gardensConfig.ts`
and `README.md`. Root contract: root `AGENTS.md` §2.
