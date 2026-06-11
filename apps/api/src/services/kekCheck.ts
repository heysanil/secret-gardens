import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  CryptoError,
  DekUnwrapError,
  KekMismatchError,
  type MasterKey,
  type PackedWrappedDek,
  packWrappedDek,
  unpackWrappedDek,
  unwrapDek,
  wrapDek,
} from "@safe/crypto";

/** Fixed, public 32-byte constant wrapped at first boot to fingerprint the KEK. */
const KEK_CHECK_CONSTANT = createHash("sha256")
  .update("safe-kek-check-v1")
  .digest();

/** Plays the role of projectId in wrapDek's AAD (`safe-dek:kek-check`). */
export const KEK_CHECK_AAD_ID = "kek-check";

/** instance_settings key holding the wrapped check constant. */
export const KEK_CHECK_SETTINGS_KEY = "kek_check";
const SETTINGS_KEY = KEK_CHECK_SETTINGS_KEY;

/** Thrown when the loaded master key cannot be verified against the database. */
export class KekCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KekCheckError";
  }
}

/**
 * Boot-time KEK verification. First boot wraps a known constant and stores it
 * in instance_settings['kek_check']; later boots unwrap it, so a wrong
 * SAFE_MASTER_KEY aborts startup with a precise error instead of runtime 500s.
 */
export function ensureKekCheck(db: Database, masterKey: MasterKey): void {
  const row = db
    .query<{ value: string }, [string]>(
      "SELECT value FROM instance_settings WHERE key = ?",
    )
    .get(SETTINGS_KEY);

  if (row === null) {
    const wrapped = wrapDek(masterKey, KEK_CHECK_CONSTANT, KEK_CHECK_AAD_ID);
    db.run("INSERT INTO instance_settings (key, value) VALUES (?, ?)", [
      SETTINGS_KEY,
      JSON.stringify(packWrappedDek(wrapped)),
    ]);
    return;
  }

  let unwrapped: Buffer;
  try {
    const packed = JSON.parse(row.value) as PackedWrappedDek;
    unwrapped = unwrapDek(
      masterKey,
      unpackWrappedDek(packed),
      KEK_CHECK_AAD_ID,
    );
  } catch (err) {
    if (err instanceof KekMismatchError || err instanceof DekUnwrapError) {
      throw new KekCheckError(
        "SAFE_MASTER_KEY does not match the key this database was initialized with. " +
          "All wrapped DEKs were created under a different master key — restore the " +
          "original SAFE_MASTER_KEY (or, if you rotated the KEK, finish the rotation " +
          "with scripts/rotate-kek). Refusing to start. " +
          `(${(err as Error).message})`,
      );
    }
    if (err instanceof SyntaxError || err instanceof CryptoError) {
      throw new KekCheckError(
        "The stored kek_check value in instance_settings is corrupted and cannot be " +
          "parsed. The SQLite database may be damaged — restore it from a backup. " +
          `(${(err as Error).message})`,
      );
    }
    throw err;
  }

  const matches = unwrapped.equals(KEK_CHECK_CONSTANT);
  unwrapped.fill(0);
  if (!matches) {
    throw new KekCheckError(
      "The stored kek_check value unwrapped successfully but does not contain the " +
        "expected constant — the instance_settings row is corrupted. Refusing to start.",
    );
  }
}
