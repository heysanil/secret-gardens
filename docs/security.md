# Security model

## Threat model

secret-gardens uses a **server-side master key**: the server can decrypt secrets while
handling requests. This is the Doppler/Infisical model, not zero-knowledge
end-to-end encryption (the data model leaves room for E2EE later — every
ciphertext record carries an `alg` field — but it is explicitly out of scope
today).

What an attacker gets from each component:

| Compromised | Yields |
|---|---|
| Redis dump (volume, RDB, AOF) alone | Nothing usable: per-secret AES-256-GCM ciphertext only. The keys to it are not in Redis. |
| SQLite database alone | Nothing usable for secret values: project metadata, memberships, **wrapped** project DEKs (undecryptable without the master key) and token *hashes*. |
| Redis + SQLite, without the env key | Still nothing: DEKs cannot be unwrapped, so secret ciphertext cannot be decrypted. |
| `GARDENS_MASTER_KEY` (env) + both stores | Full compromise of stored secrets. |
| The running server / its environment | Full compromise — see "what is not protected". |

The master key lives **only** in the server process environment
(`GARDENS_MASTER_KEY` in `.env`, mode 600). It is never written to either store;
a fingerprint (`kekId`, 16 hex chars of its SHA-256) identifies which key
wrapped which DEK.

## Encryption scheme

Envelope encryption, implemented in `packages/crypto` on `node:crypto` only
(zero third-party crypto dependencies):

1. **KEK**: `GARDENS_MASTER_KEY` is base64, exactly 32 bytes. The actual
   wrapping key is derived with HKDF-SHA256 (empty salt, info
   `secret-gardens/v1/dek-wrap`, 32-byte output), so future subkeys can derive from the
   same env var without reuse. `kekId = hex(sha256(rawKey)).slice(0, 16)`
   fingerprints the raw input for rotation tooling.
2. **Per-project DEK**: 32 random bytes, wrapped with AES-256-GCM (12-byte
   random nonce, 16-byte tag, AAD `secret-gardens-dek:{projectId}`) and stored in
   SQLite (`project_keys`, with a version and `active`/`retired` status).
3. **Per-secret encryption**: AES-256-GCM with the project DEK — 12-byte
   random nonce, 16-byte tag, and AAD `projectId:envId:secretKey` (IDs, not
   slugs, so renames are safe). Tampering with any AAD component — e.g.
   transplanting ciphertext to another key, environment or project — fails
   authentication. Every stored record carries `dekV` (which DEK version
   encrypted it) and `alg: "aes-256-gcm:v1"`.
4. **Boot check**: at first boot the server wraps a known constant and stores
   it (`instance_settings.kek_check`); every later boot unwraps it, so a
   wrong `GARDENS_MASTER_KEY` aborts startup with a precise error instead of
   serving runtime 500s.

Version history is append-only; rollback appends a new version re-using the
old ciphertext (valid because AAD excludes the version), it never rewrites
history.

## What is NOT protected

- **Server memory during requests** — plaintext secrets exist in process
  memory while being encrypted/decrypted and in responses to authorized
  callers.
- **Operators with environment access** — anyone who can read the app
  container's env or `.env` holds the master key. Note that `docker inspect`
  on the app container prints `GARDENS_MASTER_KEY`, so anyone with Docker API
  access (root or the `docker` group) can read it; hardened deployments
  should prefer Docker secrets or another env-isolation mechanism over a
  plain compose environment variable (see self-hosting.md).
- **A compromised host** — Docker host root can read everything above.
- **The Docker network** — the bundled Redis is unauthenticated on the
  compose network. It holds ciphertext only by design (see the table above),
  so a network peer learns no secret values, but it could delete or corrupt
  data (tampered ciphertext fails AES-GCM authentication on read; deletion
  is data loss). When the Docker network is not fully trusted, enable
  `requirepass` and isolate Redis on its own network (see self-hosting.md).
- **Transport beyond the proxy** — TLS is the deployment's job (see
  self-hosting.md); run the app behind a TLS-terminating reverse proxy.

## Key rotation semantics

- **KEK rotation** (`apps/api/scripts/rotate-kek.ts`): re-wraps every project
  DEK (active and retired) and the kek_check under the new key, in one
  SQLite transaction; aborts wholesale if anything is wrapped under an
  unknown key. Secret ciphertext is untouched. See self-hosting.md for the
  runbook.
- **DEK rotation** (UI or `gardens rotate dek`): generates a new DEK version,
  re-encrypts the project's *current* secrets, and retires (keeps) the old
  DEK version so historical secret versions remain decryptable via their
  recorded `dekV`.

## Authentication & tokens

- **Passwords**: argon2id via `Bun.password` (better-auth). Sessions are
  cookie-based, signed with `BETTER_AUTH_SECRET`.
- **Service tokens** `sg_st_<base64url(32 bytes)>` — project-scoped, with
  read/read_write scope, optional environment allow-list and optional
  expiry. Built for CI.
- **Personal access tokens** `sg_ut_<base64url(32 bytes)>` — act as the
  user; minted by the CLI login flow. PAT-minted PATs are capped at 30 days
  (and never outlive their parent).
- Both are stored as **SHA-256 hashes** only and the plaintext is shown
  exactly once at creation; lookups hash the presented token. Revocation is
  immediate (`revoked_at`).
- The first account created becomes the instance owner; self-signup is
  disabled automatically once the instance is bootstrapped.

Bulk secret reads (`?include_values=true`, which backs `gardens pull` and
`gardens run`) are recorded in the project audit stream, including the actor.

## Responsible disclosure

Please report suspected vulnerabilities privately to the maintainers (see
repository contacts) rather than opening a public issue, and allow a
reasonable window for a fix and release before disclosure.
