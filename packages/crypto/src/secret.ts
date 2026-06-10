import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { DecryptError } from "./errors";

export interface EncryptedSecret {
  ct: Buffer;
  nonce: Buffer;
  tag: Buffer;
}

export interface SecretAad {
  projectId: string;
  envId: string;
  secretKey: string;
}

const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Binds a ciphertext to its location: a value moved to another project,
 * environment, or key fails GCM authentication on decrypt.
 */
export function encodeAad(aad: SecretAad): Buffer {
  return Buffer.from(`${aad.projectId}:${aad.envId}:${aad.secretKey}`, "utf8");
}

export function encryptSecret(
  dek: Buffer,
  plaintext: string,
  aad: SecretAad,
): EncryptedSecret {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", dek, nonce, {
    authTagLength: TAG_BYTES,
  });
  cipher.setAAD(encodeAad(aad));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { ct, nonce, tag: cipher.getAuthTag() };
}

export function decryptSecret(
  dek: Buffer,
  enc: EncryptedSecret,
  aad: SecretAad,
): string {
  try {
    const decipher = createDecipheriv("aes-256-gcm", dek, enc.nonce, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(encodeAad(aad));
    decipher.setAuthTag(enc.tag);
    return Buffer.concat([decipher.update(enc.ct), decipher.final()]).toString(
      "utf8",
    );
  } catch {
    throw new DecryptError(
      "failed to decrypt secret: GCM authentication failed (tampered data, wrong DEK, or mismatched AAD)",
    );
  }
}
