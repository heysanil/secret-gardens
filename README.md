# safe

**safe** is a self-hosted, open-source secrets manager. Teams store secrets per
project and environment, manage them in a web admin UI, and pull/push/inject
them via the `safe` CLI — including in CI with scoped service tokens. Built on
Bun + Elysia + Redis + SQLite.

- **Envelope encryption** — AES-256-GCM per secret, per-project data keys
  wrapped by a master key that only ever lives in the server environment.
  Redis and SQLite alone (or together) are useless without it.
- **Projects & environments** — user-definable environments per project
  (default `dev` / `staging` / `prod`).
- **Versioning + rollback** — append-only history per secret; roll back to any
  version.
- **RBAC** — per-project roles (`admin` / `write` / `read`) plus instance
  owner/admin.
- **Audit log** — append-only streams per project and instance, including
  bulk-read events.
- **Service tokens** — project-scoped, environment-scoped, read or read/write,
  with expiry. Made for CI.
- **Web UI** — React admin for projects, secrets, members, tokens, history and
  audit.
- **CLI** — `safe pull/push/run`: inject secrets into any process without
  writing them to disk.

## Self-hosting quickstart

Requirements: Docker with Compose.

```sh
git clone https://github.com/your-org/safe.git && cd safe
scripts/setup.sh           # generates .env — BACK UP SAFE_MASTER_KEY
docker compose up -d
```

Open http://localhost:3000 and create the first account — it becomes the
instance owner, and self-signup closes automatically afterwards (admins create
users from the UI).

See [docs/self-hosting.md](docs/self-hosting.md) for the env var reference,
backups, key rotation and reverse-proxy setup, and
[docs/security.md](docs/security.md) for the threat model and encryption
scheme.

## CLI

From a checkout, the CLI runs directly under Bun:

```sh
bun apps/cli/src/index.ts login --host https://safe.example.com
```

Or build self-contained binaries (no Bun required on the target machine) with
`scripts/build-cli.sh`, which compiles `dist/cli/safe-<target>` for
linux/darwin × x64/arm64 — rename the one you need to `safe` and put it on
your `PATH`.

| Command | What it does |
|---|---|
| `safe login [--host URL] [--token PAT]` | Browser approval flow, or `--token` for headless |
| `safe logout` / `safe whoami` | Revoke + remove local credentials / show identity |
| `safe init [--project slug] [--env slug] [--yes]` | Write `.safe.json` for this directory |
| `safe pull [-e env] [--out FILE] [--format dotenv\|json]` | Download secrets to a dotenv/JSON file |
| `safe push [-e env] [--file FILE] [--prune]` | Upload a dotenv file (bulk upsert) |
| `safe run [-e env] -- <cmd...>` | Run a command with secrets injected as env vars |
| `safe secrets list\|get K\|set K V\|rm K [-e env]` | Inspect and edit individual secrets |
| `safe rotate dek [--project slug] [--yes]` | Rotate a project's data-encryption key |

`.safe.json` (written by `safe init`, safe to commit) pins the host, project
and default environment; the CLI walks up from the current directory to find
it, like git.

**CI:** create a service token (project → tokens) and set it as `SAFE_TOKEN` —
no login needed:

```sh
SAFE_TOKEN=safe_st_... safe run -- ./deploy.sh
```

## Development

```sh
bun install
docker compose -f compose.test.yml up -d   # test Redis on :6380
bun run test                                # all workspaces via turbo
```

Dev servers: `cd apps/api && bun --watch src/index.ts` (needs
`SAFE_MASTER_KEY`, `BETTER_AUTH_SECRET` and a local Redis) and
`cd apps/web && bun run dev` (Vite on :5173, proxies `/api` to :3000 — add
`SAFE_ADDITIONAL_ORIGINS=http://localhost:5173` to the API env).

Root gates: `bun run lint`, `bun run typecheck`, `bun run test`,
`bun run build`.

Note: the deployment stack (`docker compose up`) and the test Redis
(`compose.test.yml`) share the compose project name — run one at a time, or
give the test stack its own project: `docker compose -p safe-test -f
compose.test.yml up -d` (tests connect to :6380 either way).

Adding a workspace? `docker/Dockerfile` copies every workspace's
`package.json` explicitly (in both stages) — add the new manifest there
too, or the image build fails at `bun install --frozen-lockfile`.

## Documentation

- [docs/self-hosting.md](docs/self-hosting.md) — env vars, backup & restore,
  KEK/DEK rotation, reverse proxy
- [docs/security.md](docs/security.md) — threat model, encryption scheme,
  token formats

## License

[AGPL-3.0](./LICENSE)
