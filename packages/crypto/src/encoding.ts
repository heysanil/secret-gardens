import type { WrappedDek } from "./dek";
import { CryptoError } from "./errors";
import type { KekId } from "./masterKey";
import type { EncryptedSecret } from "./secret";

/** Standard base64 with correct padding; the empty string is valid (empty buffer). */
const STRICT_BASE64_RE =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function isStrictBase64(value: string): boolean {
  return STRICT_BASE64_RE.test(value);
}

const KEK_ID_RE = /^[0-9a-f]{16}$/;

const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const WRAPPED_DEK_BYTES = 32;

function decodeBase64Field(value: string, field: string): Buffer {
  if (!isStrictBase64(value)) {
    throw new CryptoError(`field "${field}" is not valid base64`);
  }
  return Buffer.from(value, "base64");
}

function decodeFixedLengthField(
  value: string,
  field: string,
  expectedBytes: number,
): Buffer {
  const decoded = decodeBase64Field(value, field);
  if (decoded.length !== expectedBytes) {
    throw new CryptoError(
      `field "${field}" must decode to exactly ${expectedBytes} bytes, got ${decoded.length}`,
    );
  }
  return decoded;
}

export interface PackedEncrypted {
  ct: string;
  nonce: string;
  tag: string;
}

export function packEncrypted(e: EncryptedSecret): PackedEncrypted {
  return {
    ct: e.ct.toString("base64"),
    nonce: e.nonce.toString("base64"),
    tag: e.tag.toString("base64"),
  };
}

export function unpackEncrypted(p: PackedEncrypted): EncryptedSecret {
  return {
    // ct length is unconstrained: AES-GCM of an empty plaintext yields a
    // 0-byte ct, and the empty string is valid base64 for it.
    ct: decodeBase64Field(p.ct, "ct"),
    nonce: decodeFixedLengthField(p.nonce, "nonce", NONCE_BYTES),
    tag: decodeFixedLengthField(p.tag, "tag", TAG_BYTES),
  };
}

export interface PackedWrappedDek {
  wrapped: string;
  nonce: string;
  tag: string;
  kekId: KekId;
}

export function packWrappedDek(w: WrappedDek): PackedWrappedDek {
  return {
    wrapped: w.wrapped.toString("base64"),
    nonce: w.nonce.toString("base64"),
    tag: w.tag.toString("base64"),
    kekId: w.kekId,
  };
}

export function unpackWrappedDek(p: PackedWrappedDek): WrappedDek {
  if (!KEK_ID_RE.test(p.kekId)) {
    throw new CryptoError(
      'field "kekId" must be exactly 16 lowercase hex characters',
    );
  }
  return {
    wrapped: decodeFixedLengthField(p.wrapped, "wrapped", WRAPPED_DEK_BYTES),
    nonce: decodeFixedLengthField(p.nonce, "nonce", NONCE_BYTES),
    tag: decodeFixedLengthField(p.tag, "tag", TAG_BYTES),
    kekId: p.kekId,
  };
}
