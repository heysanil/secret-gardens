import { openapi } from "@elysiajs/openapi";

/**
 * Version reported in the OpenAPI info block. Kept in sync with
 * apps/api/package.json's "version" — enforced by openapi.test.ts (a JSON
 * import here would force resolveJsonModule onto every workspace that
 * typechecks the App type through src/index.ts).
 */
export const API_VERSION = "0.0.1";

/**
 * info.description — rendered by Scalar as the document intro; each `##`
 * heading becomes a sidebar section. Deliberately contains NO double-quote
 * characters: the plugin interpolates it into a <meta content="…"> attribute
 * verbatim.
 */
const DESCRIPTION = `
## Overview

secret-gardens is a self-hosted, open-source secrets manager (AGPL-3.0-only).
Teams store secrets per project and environment, manage them in a web admin
UI, and pull/push/inject them with the \`gardens\` CLI — including in CI via
scoped service tokens. This specification covers the full JSON API: the same
surface the web UI and the CLI are built on.

Every secret value is protected with **envelope encryption**. The server
holds a single master key (the \`GARDENS_MASTER_KEY\` environment variable)
that never leaves the server process. Each project gets its own
data-encryption key (DEK), and every secret value is encrypted with
AES-256-GCM under that DEK, with the ciphertext cryptographically bound to
its \`projectId:envId:secretKey\` location — records cannot be swapped or
replayed across projects, environments, or keys.

DEKs are stored only in wrapped (encrypted) form in SQLite, while secret
ciphertext lives in Redis: either store alone — or both together — is
useless without the master key. Values are decrypted only inside the API
process, only on request, and never appear in audit entries, logs, or error
messages. The full threat model is in
[docs/security.md](https://github.com/heysanil/secret-gardens/blob/main/docs/security.md).

## Getting started

Self-hosting needs Docker with Compose:

\`\`\`sh
git clone https://github.com/heysanil/secret-gardens.git && cd secret-gardens
scripts/setup.sh      # generates .env — BACK UP GARDENS_MASTER_KEY
docker compose up -d
\`\`\`

Open the instance URL (default http://localhost:3000) and create the first
account — it becomes the **instance owner**, and self-signup closes
automatically afterwards (admins create further users from the UI). Create a
project (it starts with \`dev\`, \`staging\` and \`prod\` environments), add
secrets in the UI or via \`PUT …/secrets\`, then pull them anywhere with the
CLI.

## Authentication

Three kinds of principal can call this API:

| Principal | Transport | Where it comes from |
|---|---|---|
| Browser session | \`better-auth.session_token\` cookie | Sign-in under \`/api/auth/*\` (web UI) |
| Personal access token | \`Authorization: Bearer sg_ut_…\` | \`POST /api/me/tokens\` or \`gardens login\` |
| Service token | \`Authorization: Bearer sg_st_…\` | \`POST /api/projects/{projectId}/tokens\` |

**Personal access tokens (PATs)** act as the user who minted them, with that
user's full permissions. A PAT minted while authenticating *with* a PAT is
capped at min(30 days, the parent token's remaining lifetime) — a leaked
short-lived token cannot mint longer-lived successors. Sessions may mint
PATs with any expiry up to 365 days, or none.

**Service tokens** are project- and environment-scoped with scope \`read\`
or \`read_write\` — made for CI. They can read (and with \`read_write\`,
write) secrets in their allowed environments, plus one deliberate exception:
a filtered project-detail read (\`GET /api/projects/{projectId}\`) so CI can
resolve environment slugs to ids. Everything else — version history, audit,
members, token management — is user-only. A service token probing any other
project gets \`404 not_found\`; the API never reveals which project ids
exist.

**Show-once semantics:** the create responses are the only place token
plaintext ever appears. The server stores a SHA-256 hash plus a 12-character
display prefix; a token cannot be retrieved again after creation.

## Auth endpoints (better-auth)

Sign-up, sign-in and session management under \`/api/auth/*\` are handled by
the mounted [better-auth](https://www.better-auth.com) handler and are not
part of this specification. The key endpoints:

| Endpoint | Purpose |
|---|---|
| \`POST /api/auth/sign-up/email\` | Create an account. Closed once a first user exists (\`403 signup_disabled\`) |
| \`POST /api/auth/sign-in/email\` | Email + password sign-in (failed attempts are audited) |
| \`POST /api/auth/sign-out\` | End the current session |
| \`GET /api/auth/get-session\` | Current session, or \`null\` when signed out |

See the [better-auth documentation](https://www.better-auth.com/docs) for
the full surface.

## The gardens CLI

| Command | What it does |
|---|---|
| \`gardens login [--host URL] [--token PAT]\` | Browser approval flow, or \`--token\` for headless |
| \`gardens logout\` / \`gardens whoami\` | Revoke + remove local credentials / show identity |
| \`gardens init\` | Write \`.gardens.json\` for this directory |
| \`gardens pull [-e env]\` | Download secrets to a dotenv/JSON file |
| \`gardens push [-e env] [--prune]\` | Upload a dotenv file (bulk upsert) |
| \`gardens run [-e env] -- <cmd>\` | Run a command with secrets injected as env vars |
| \`gardens secrets list\\|get\\|set\\|rm\` | Inspect and edit individual secrets |
| \`gardens rotate dek\` | Rotate a project's data-encryption key |

\`.gardens.json\` (written by \`gardens init\`, safe to commit) pins the
host, project and default environment; the CLI walks up from the current
directory to find it, like git.

\`gardens login\` uses a loopback flow: the CLI starts a localhost-only
listener, opens the instance's \`/cli-auth\` page in your browser, and the
signed-in web app mints a PAT and hands it back to the listener — your
password never passes through the CLI. In CI, skip login entirely: set
\`GARDENS_TOKEN\` to a service token (\`sg_st_…\`) and run
\`gardens pull/run/push\` directly.

## Errors

Errors are JSON with a machine-readable \`error\` field:
\`{ error: 'some_code' }\`. Requests that fail schema validation return
Elysia's standard 422 validation shape instead. Codes in use:

| Code | HTTP | Meaning |
|---|---|---|
| \`unauthorized\` | 401 | No usable session or token on a protected route |
| \`invalid_token\` | 401 | Bearer token is malformed, unknown, expired, or revoked |
| \`forbidden\` | 403 | Authenticated, but the role/scope does not allow this action |
| \`not_found\` | 404 | Resource does not exist — or the caller may not know it exists |
| \`signup_disabled\` | 403 | Self-signup is closed (a first user already exists) |
| \`duplicate_slug\` | 409 | Project or environment slug already taken |
| \`invalid_slug\` | 422 | Slug fails the lowercase/digits/hyphens pattern |
| \`already_member\` | 409 | User is already a member of the project |
| \`last_admin\` | 409 | Would leave the project without an explicit admin |
| \`invalid_key\` | 422 | Secret key fails validation |
| \`invalid_value\` | 422 | Secret value fails validation |
| \`invalid_secrets\` | 422 | Bulk payload contains invalid keys/values (offenders in \`keys\`) |
| \`too_many_secrets\` | 422 | Bulk payload exceeds 1000 entries |
| \`invalid_environment_ids\` | 422 | Token creation names unknown environment ids (offenders echoed) |
| \`invalid_action\` | 422 | Audit filter names an unknown action |
| \`invalid_cursor\` | 422 | Audit cursor is not a well-formed stream id |
| \`invalid_limit\` | 422 | Audit limit is not an integer in 1–100 |
| \`cannot_rollback_to_delete\` | 400 | Rollback target version is a deletion tombstone |
| \`parent_token_expired\` | 422 | The PAT used to mint a new PAT has already expired |
| \`decrypt_failed\` | 500 | A stored ciphertext failed to decrypt (see server logs) |
| \`internal_error\` | 500 | Unexpected server-side failure; the operation was rolled back (see server logs) |

The 404-vs-403 rule is deliberate: non-members (and service tokens probing
foreign projects) always get \`404 not_found\`, never \`403\`, so the API
does not leak which project ids exist.

## Pagination

The audit endpoint paginates with cursors. Responses are
\`{ entries, nextCursor }\`: \`nextCursor\` is the id of the last entry in a
full page, or \`null\` when there is nothing further. Pass it back as
\`?cursor=\` to fetch the next page. Cursors are **exclusive** — the entry a
cursor names is not repeated — and entries are returned newest-first.
Cursors are Redis stream entry ids (\`<ms>-<seq>\`); treat them as opaque.
`;

/**
 * OpenAPI documentation at GET /docs (Scalar UI) and GET /docs/json (spec).
 * Both are PUBLIC by design — the API surface is open source; the spec
 * carries no instance data.
 *
 * exclude.paths is exact-string matching in @elysiajs/openapi 1.4 (regexes
 * are silently ignored), so the non-API noise is excluded by its literal
 * route path:
 *  - '/*'  — the better-auth `.mount()` catch-all and the static-mode SPA
 *    fallback (staticWeb.ts) both register this path;
 *  - '/' and '' — the static-mode index.html routes (@elysiajs/static
 *    registers the indexHTML route under both);
 *  - '/api/auth/sign-in/email' — the explicit sign-in wrapper in app.ts
 *    (better-auth's surface is documented prose-only, see DESCRIPTION).
 * Static dist files are excluded by the plugin's default staticFile rule
 * (any path containing a dot). staticWeb.test.ts pins all of this.
 */
export function openapiPlugin() {
  return openapi({
    path: "/docs",
    exclude: {
      paths: ["", "/", "/*", "/api/auth/sign-in/email"],
      methods: ["options", "head"],
    },
    documentation: {
      info: {
        title: "secret-gardens API",
        version: API_VERSION,
        description: DESCRIPTION,
        license: {
          name: "AGPL-3.0-only",
          url: "https://github.com/heysanil/secret-gardens/blob/main/LICENSE",
        },
      },
      // Default for every operation: either token kind or a browser session.
      // Public routes (health, bootstrap) override with `security: []`.
      security: [{ bearerAuth: [] }, { cookieAuth: [] }],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: "http",
            scheme: "bearer",
            description:
              "Personal access token (`sg_ut_…`, acts as the minting user) " +
              "or service token (`sg_st_…`, project- and environment-scoped, " +
              "secrets read/write only). Send as `Authorization: Bearer <token>`.",
          },
          cookieAuth: {
            type: "apiKey",
            in: "cookie",
            name: "better-auth.session_token",
            description:
              "Browser session cookie issued by the better-auth endpoints " +
              "under /api/auth/*.",
          },
        },
      },
      tags: [
        {
          name: "Health",
          description: "Liveness and dependency checks. Public.",
        },
        {
          name: "Bootstrap",
          description: "First-run state for the web setup flow. Public.",
        },
        {
          name: "Account",
          description:
            "The signed-in user and their personal access tokens (PATs).",
        },
        {
          name: "Users",
          description:
            "Instance user directory (powers the member picker in the UI).",
        },
        { name: "Projects", description: "Project listing and CRUD." },
        {
          name: "Environments",
          description:
            "Per-project environments. Slugs are immutable after creation; " +
            "environment lists ride on the project detail (no list route).",
        },
        {
          name: "Secrets",
          description:
            "Encrypted key-value secrets per project environment. The only " +
            "routes (besides the filtered project detail) that service " +
            "tokens can call.",
        },
        {
          name: "Versions",
          description:
            "Append-only per-secret version history and rollback. History " +
            "is never rewritten or deleted.",
        },
        { name: "Members", description: "Project membership and roles." },
        {
          name: "Service Tokens",
          description:
            "Project-scoped CI tokens (`sg_st_…`): read or read_write, " +
            "optionally limited to specific environments.",
        },
        {
          name: "Audit",
          description:
            "Append-only project audit trail (cursor-paginated; see the " +
            "Pagination section).",
        },
        {
          name: "Rotation",
          description: "Per-project data-encryption-key (DEK) rotation.",
        },
      ],
    },
  });
}
