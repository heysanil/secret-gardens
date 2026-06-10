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

function decodeBase64Field(value: string, field: string): Buffer {
  if (!isStrictBase64(value)) {
    throw new CryptoError(`field "${field}" is not valid base64`);
  }
  return Buffer.from(value, "base64");
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
    ct: decodeBase64Field(p.ct, "ct"),
    nonce: decodeBase64Field(p.nonce, "nonce"),
    tag: decodeBase64Field(p.tag, "tag"),
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
  return {
    wrapped: decodeBase64Field(p.wrapped, "wrapped"),
    nonce: decodeBase64Field(p.nonce, "nonce"),
    tag: decodeBase64Field(p.tag, "tag"),
    kekId: p.kekId,
  };
}
