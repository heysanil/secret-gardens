import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { DekUnwrapError, KekMismatchError, MasterKeyError } from "./errors";
import { getWrappingKey, type KekId, type MasterKey } from "./masterKey";

export interface WrappedDek {
  wrapped: Buffer;
  nonce: Buffer;
  tag: Buffer;
  kekId: KekId;
}

const DEK_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

function dekAad(projectId: string): Buffer {
  return Buffer.from(`safe-dek:${projectId}`, "utf8");
}

export function generateDek(): Buffer {
  return randomBytes(DEK_BYTES);
}

export function wrapDek(
  mk: MasterKey,
  dek: Buffer,
  projectId: string,
): WrappedDek {
  if (dek.length !== DEK_BYTES) {
    throw new MasterKeyError(
      `dek must be exactly ${DEK_BYTES} bytes, got ${dek.length}`,
    );
  }
  const wrappingKey = getWrappingKey(mk);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", wrappingKey, nonce, {
    authTagLength: TAG_BYTES,
  });
  cipher.setAAD(dekAad(projectId));
  const wrapped = Buffer.concat([cipher.update(dek), cipher.final()]);
  return { wrapped, nonce, tag: cipher.getAuthTag(), kekId: mk.kekId };
}

/**
 * Unwraps a project DEK.
 *
 * Ownership contract: the returned Buffer is a fresh allocation owned by the
 * caller. If a cache stores it and shares it with consumers, the cache must
 * NOT zero it (e.g. `fill(0)`) while shares may still be in flight — zeroing
 * mutates every reference to the same Buffer.
 */
export function unwrapDek(
  mk: MasterKey,
  w: WrappedDek,
  projectId: string,
): Buffer {
  // Deliberately a plain (non-constant-time) comparison: kekId is a public
  // fingerprint stored alongside the row, so timing leaks nothing secret.
  if (w.kekId !== mk.kekId) {
    throw new KekMismatchError(
      `wrapped DEK was created with KEK ${w.kekId} but the loaded master key is ${mk.kekId}; ` +
        "check that SAFE_MASTER_KEY is correct, or finish rotating the KEK",
    );
  }
  const wrappingKey = getWrappingKey(mk);
  try {
    const decipher = createDecipheriv("aes-256-gcm", wrappingKey, w.nonce, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(dekAad(projectId));
    decipher.setAuthTag(w.tag);
    return Buffer.concat([decipher.update(w.wrapped), decipher.final()]);
  } catch {
    throw new DekUnwrapError(
      "failed to unwrap DEK: GCM authentication failed (wrong key, tampered data, or mismatched project)",
    );
  }
}
