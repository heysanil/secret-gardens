import { createHash, hkdfSync, randomBytes } from "node:crypto";
import { isStrictBase64 } from "./encoding";
import { MasterKeyError } from "./errors";

/** 16 lowercase hex chars = hex(sha256(rawKeyBytes)).slice(0, 16). */
export type KekId = string;

export interface MasterKey {
  readonly kekId: KekId;
}

const MASTER_KEY_BYTES = 32;
const WRAPPING_KEY_BYTES = 32;
const KEK_ID_HEX_CHARS = 16;
const HKDF_INFO = "safe/v1/dek-wrap";

/**
 * Holds the derived wrapping key in a #private field so it is invisible to
 * JSON.stringify, Object.keys, Object.entries, and property enumeration.
 */
class MasterKeyImpl implements MasterKey {
  readonly kekId: KekId;
  readonly #wrappingKey: Buffer;

  constructor(kekId: KekId, wrappingKey: Buffer) {
    this.kekId = kekId;
    this.#wrappingKey = wrappingKey;
  }

  static wrappingKeyOf(mk: MasterKey): Buffer {
    if (!(mk instanceof MasterKeyImpl)) {
      throw new MasterKeyError("master key was not created by loadMasterKey()");
    }
    return mk.#wrappingKey;
  }
}

/** Internal accessor for sibling modules; not exported from the package. */
export function getWrappingKey(mk: MasterKey): Buffer {
  return MasterKeyImpl.wrappingKeyOf(mk);
}

/** Returns base64(randomBytes(32)) — used by setup.sh to mint SAFE_MASTER_KEY. */
export function generateMasterKey(): string {
  return randomBytes(MASTER_KEY_BYTES).toString("base64");
}

/**
 * Validates and loads the master key from an env-var value.
 * Error messages describe the problem without ever echoing the value.
 */
export function loadMasterKey(envValue: string | undefined): MasterKey {
  if (envValue === undefined) {
    throw new MasterKeyError(
      "master key is not set; expected a base64-encoded 32-byte key",
    );
  }
  if (envValue.length === 0) {
    throw new MasterKeyError(
      "master key is empty; expected a base64-encoded 32-byte key",
    );
  }
  if (!isStrictBase64(envValue)) {
    throw new MasterKeyError(
      "master key is not valid base64; expected a base64-encoded 32-byte key",
    );
  }
  const rawKey = Buffer.from(envValue, "base64");
  if (rawKey.length !== MASTER_KEY_BYTES) {
    throw new MasterKeyError(
      `master key must decode to exactly ${MASTER_KEY_BYTES} bytes, got ${rawKey.length}`,
    );
  }

  // kekId fingerprints the RAW input (not the derived key) so rotation
  // tooling can identify which env var wrapped which DEK.
  const kekId = createHash("sha256")
    .update(rawKey)
    .digest("hex")
    .slice(0, KEK_ID_HEX_CHARS);

  // HKDF subkey rather than using the raw env key directly as the AES key —
  // future keys (token pepper, v2 schemes) derive from the same env var.
  const wrappingKey = Buffer.from(
    hkdfSync("sha256", rawKey, Buffer.alloc(0), HKDF_INFO, WRAPPING_KEY_BYTES),
  );

  return new MasterKeyImpl(kekId, wrappingKey);
}
