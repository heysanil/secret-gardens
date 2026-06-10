import { describe, expect, test } from "bun:test";
import {
  CryptoError,
  decryptSecret,
  encryptSecret,
  generateDek,
  generateMasterKey,
  loadMasterKey,
  packEncrypted,
  packWrappedDek,
  type SecretAad,
  unpackEncrypted,
  unpackWrappedDek,
  unwrapDek,
  wrapDek,
} from "./index";

const aad: SecretAad = {
  projectId: "proj_1",
  envId: "env_1",
  secretKey: "API_KEY",
};

describe("packEncrypted / unpackEncrypted", () => {
  const dek = generateDek();

  test("round-trips exactly (Buffer.equals on every field)", () => {
    const enc = encryptSecret(dek, "hello world", aad);
    const packed = packEncrypted(enc);
    expect(typeof packed.ct).toBe("string");
    expect(typeof packed.nonce).toBe("string");
    expect(typeof packed.tag).toBe("string");

    const unpacked = unpackEncrypted(packed);
    expect(unpacked.ct.equals(enc.ct)).toBe(true);
    expect(unpacked.nonce.equals(enc.nonce)).toBe(true);
    expect(unpacked.tag.equals(enc.tag)).toBe(true);
    expect(decryptSecret(dek, unpacked, aad)).toBe("hello world");
  });

  test("round-trips an empty ciphertext (empty plaintext)", () => {
    const enc = encryptSecret(dek, "", aad);
    const unpacked = unpackEncrypted(packEncrypted(enc));
    expect(unpacked.ct.equals(enc.ct)).toBe(true);
    expect(decryptSecret(dek, unpacked, aad)).toBe("");
  });

  test("rejects invalid base64 with a CryptoError, not a cryptic TypeError", () => {
    const enc = packEncrypted(encryptSecret(dek, "v", aad));
    expect(() => unpackEncrypted({ ...enc, ct: "%%%not base64%%%" })).toThrow(
      CryptoError,
    );
    expect(() => unpackEncrypted({ ...enc, nonce: "a" })).toThrow(CryptoError);
    expect(() => unpackEncrypted({ ...enc, tag: "!!!" })).toThrow(CryptoError);
  });
});

describe("packWrappedDek / unpackWrappedDek", () => {
  const mk = loadMasterKey(generateMasterKey());
  const projectId = "proj_1";

  test("round-trips exactly (Buffer.equals on every field, kekId preserved)", () => {
    const dek = generateDek();
    const w = wrapDek(mk, dek, projectId);
    const packed = packWrappedDek(w);
    expect(typeof packed.wrapped).toBe("string");
    expect(typeof packed.nonce).toBe("string");
    expect(typeof packed.tag).toBe("string");
    expect(packed.kekId).toBe(mk.kekId);

    const unpacked = unpackWrappedDek(packed);
    expect(unpacked.wrapped.equals(w.wrapped)).toBe(true);
    expect(unpacked.nonce.equals(w.nonce)).toBe(true);
    expect(unpacked.tag.equals(w.tag)).toBe(true);
    expect(unpacked.kekId).toBe(w.kekId);
    expect(unwrapDek(mk, unpacked, projectId).equals(dek)).toBe(true);
  });

  test("rejects invalid base64 with a CryptoError, not a cryptic TypeError", () => {
    const packed = packWrappedDek(wrapDek(mk, generateDek(), projectId));
    expect(() =>
      unpackWrappedDek({ ...packed, wrapped: "not base64 at all!" }),
    ).toThrow(CryptoError);
    expect(() => unpackWrappedDek({ ...packed, nonce: "=" })).toThrow(
      CryptoError,
    );
    expect(() => unpackWrappedDek({ ...packed, tag: "ab=c" })).toThrow(
      CryptoError,
    );
  });
});
