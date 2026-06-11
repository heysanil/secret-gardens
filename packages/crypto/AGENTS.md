# @secret-gardens/crypto — agent guide

Envelope-encryption primitives. Pure functions over `node:crypto` — no IO,
no env access, **zero runtime dependencies** (check `package.json`: there is
no `dependencies` field; keep it that way). This is the ONLY workspace
allowed to touch crypto primitives.

Hierarchy: env-var KEK (`GARDENS_MASTER_KEY`, base64 32 bytes) →
HKDF-SHA256 wrapping key → per-project DEK (wrapped, stored in SQLite by the
API) → AES-256-GCM per secret with AAD `projectId:envId:secretKey`.

## Key files

- `src/masterKey.ts` — `loadMasterKey` (validates, derives the wrapping key
  into a `#private` field invisible to JSON/enumeration), `generateMasterKey`,
  `kekId` = first 16 hex chars of sha256(raw key).
- `src/dek.ts` — `generateDek` / `wrapDek` / `unwrapDek` (AES-256-GCM,
  12-byte nonce, 16-byte tag, AAD `secret-gardens-dek:{projectId}`).
- `src/secret.ts` — `encryptSecret` / `decryptSecret` (AAD
  `projectId:envId:secretKey`; the AAD wire format is module-internal).
- `src/encoding.ts` — base64 packing for storage (`packEncrypted`,
  `packWrappedDek`, strict-base64 validation).
- `src/errors.ts` — `CryptoError` hierarchy (`MasterKeyError`,
  `DekUnwrapError`, `KekMismatchError`, `DecryptError`).

## Invariants

- **Label strings are DATA-COMPATIBILITY-CRITICAL — frozen.** Changing any
  of `secret-gardens/v1/dek-wrap` (HKDF info), `secret-gardens-dek:` (DEK
  AAD prefix), or the AAD layout makes every existing deployment's wrapped
  DEKs/ciphertext fail GCM authentication: **the data is bricked**. New
  schemes get NEW labels (v2) plus migration logic — never edits.
- **`unwrapDek` ownership contract**: the returned Buffer is a fresh
  allocation owned by the caller. Caches (see
  `apps/api/src/services/dekService.ts`) hand it out by reference and must
  NEVER zero it (`fill(0)`) — zeroing mutates every share in flight.
  Disposal is left to GC.
- Error messages never echo key material or values (`loadMasterKey`
  describes problems without the value; decrypt failures say only
  "authentication failed" + the suspected cause class).
- `getWrappingKey` is package-private (`@internal`) — never import it
  outside this package.
- AAD components are ids, never slugs; ids never contain `:` (the AAD
  delimiter) — enforced upstream in `apps/api/src/db/ids.ts`.
- Nonces are always fresh `randomBytes(12)`; never accept caller-supplied
  nonces.

## Commands

```sh
cd packages/crypto && bun test    # pure unit tests, no Redis needed
cd packages/crypto && bun run lint && bun run typecheck
```

## Update docs when you change…

ANYTHING here → `docs/security.md` (the "Encryption scheme" section
describes these exact parameters and labels) and the crypto row of root
`AGENTS.md` §2. New algorithms/versions → also `alg` handling in
`apps/api/src/services/secretService.ts` and the design notes. Root
contract: root `AGENTS.md` §2.
