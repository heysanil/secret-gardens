/**
 * Envelope-encryption primitives for safe.
 *
 * Hierarchy: env-var KEK (SAFE_MASTER_KEY) → HKDF wrapping key →
 * per-project DEK (wrapped, stored in SQLite) → AES-256-GCM per secret
 * with AAD `projectId:envId:secretKey`.
 *
 * Pure functions over node:crypto — no IO, no env access, zero deps.
 */
export type { WrappedDek } from "./dek";
export { generateDek, unwrapDek, wrapDek } from "./dek";
export type { PackedEncrypted, PackedWrappedDek } from "./encoding";
export {
  packEncrypted,
  packWrappedDek,
  unpackEncrypted,
  unpackWrappedDek,
} from "./encoding";
export {
  CryptoError,
  DecryptError,
  DekUnwrapError,
  KekMismatchError,
  MasterKeyError,
} from "./errors";
export type { KekId, MasterKey } from "./masterKey";
export { generateMasterKey, loadMasterKey } from "./masterKey";
export type { EncryptedSecret, SecretAad } from "./secret";
export { decryptSecret, encodeAad, encryptSecret } from "./secret";
