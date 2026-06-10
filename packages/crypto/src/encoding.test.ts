import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
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

  test("rejects a nonce that does not decode to exactly 12 bytes", () => {
    const enc = packEncrypted(encryptSecret(dek, "v", aad));
    const tooShort = randomBytes(11).toString("base64");
    const tooLong = randomBytes(13).toString("base64");
    expect(() => unpackEncrypted({ ...enc, nonce: tooShort })).toThrow(
      CryptoError,
    );
    expect(() => unpackEncrypted({ ...enc, nonce: tooLong })).toThrow(
      CryptoError,
    );
  });

  test("rejects a tag that does not decode to exactly 16 bytes", () => {
    const enc = packEncrypted(encryptSecret(dek, "v", aad));
    const tooShort = randomBytes(15).toString("base64");
    const tooLong = randomBytes(17).toString("base64");
    expect(() => unpackEncrypted({ ...enc, tag: tooShort })).toThrow(
      CryptoError,
    );
    expect(() => unpackEncrypted({ ...enc, tag: tooLong })).toThrow(
      CryptoError,
    );
  });

  test("accepts an empty ct (no length constraint on ciphertext)", () => {
    const enc = packEncrypted(encryptSecret(dek, "", aad));
    expect(enc.ct).toBe("");
    expect(unpackEncrypted(enc).ct.length).toBe(0);
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

  test("rejects wrapped that does not decode to exactly 32 bytes", () => {
    const packed = packWrappedDek(wrapDek(mk, generateDek(), projectId));
    const tooShort = randomBytes(31).toString("base64");
    const tooLong = randomBytes(33).toString("base64");
    expect(() => unpackWrappedDek({ ...packed, wrapped: tooShort })).toThrow(
      CryptoError,
    );
    expect(() => unpackWrappedDek({ ...packed, wrapped: tooLong })).toThrow(
      CryptoError,
    );
  });

  test("rejects a nonce that does not decode to exactly 12 bytes", () => {
    const packed = packWrappedDek(wrapDek(mk, generateDek(), projectId));
    const tooShort = randomBytes(11).toString("base64");
    const tooLong = randomBytes(13).toString("base64");
    expect(() => unpackWrappedDek({ ...packed, nonce: tooShort })).toThrow(
      CryptoError,
    );
    expect(() => unpackWrappedDek({ ...packed, nonce: tooLong })).toThrow(
      CryptoError,
    );
  });

  test("rejects a tag that does not decode to exactly 16 bytes", () => {
    const packed = packWrappedDek(wrapDek(mk, generateDek(), projectId));
    const tooShort = randomBytes(15).toString("base64");
    const tooLong = randomBytes(17).toString("base64");
    expect(() => unpackWrappedDek({ ...packed, tag: tooShort })).toThrow(
      CryptoError,
    );
    expect(() => unpackWrappedDek({ ...packed, tag: tooLong })).toThrow(
      CryptoError,
    );
  });

  test("rejects a kekId that is not exactly 16 lowercase hex chars", () => {
    const packed = packWrappedDek(wrapDek(mk, generateDek(), projectId));
    const badKekIds = [
      "", // empty
      "abc123", // too short
      "0123456789abcdef0", // too long
      "0123456789ABCDEF", // uppercase hex
      "ghijklmnopqrstuv", // non-hex chars, right length
    ];
    for (const kekId of badKekIds) {
      expect(() => unpackWrappedDek({ ...packed, kekId })).toThrow(CryptoError);
    }
    // sanity: the real kekId still passes
    expect(unpackWrappedDek(packed).kekId).toBe(mk.kekId);
  });
});
