import { describe, expect, test } from "bun:test";
import {
  DecryptError,
  decryptSecret,
  encodeAad,
  encryptSecret,
  generateDek,
  type SecretAad,
} from "./index";

function flipBit(buf: Buffer, index = 0): Buffer {
  const copy = Buffer.from(buf);
  copy.writeUInt8(copy.readUInt8(index) ^ 0x01, index);
  return copy;
}

const aad: SecretAad = {
  projectId: "proj_1",
  envId: "env_1",
  secretKey: "DATABASE_URL",
};

describe("encodeAad", () => {
  test("encodes exactly utf8 of projectId:envId:secretKey", () => {
    const encoded = encodeAad(aad);
    expect(
      encoded.equals(Buffer.from("proj_1:env_1:DATABASE_URL", "utf8")),
    ).toBe(true);
  });
});

describe("encryptSecret / decryptSecret", () => {
  const dek = generateDek();

  test("round-trips a normal string", () => {
    const enc = encryptSecret(dek, "postgres://user:pass@host:5432/db", aad);
    expect(decryptSecret(dek, enc, aad)).toBe(
      "postgres://user:pass@host:5432/db",
    );
  });

  test("round-trips the empty string", () => {
    const enc = encryptSecret(dek, "", aad);
    expect(enc.ct.length).toBe(0);
    expect(decryptSecret(dek, enc, aad)).toBe("");
  });

  test("round-trips unicode (emoji + CJK)", () => {
    const plaintext = "🔐 秘密の値 機密データ 🚀";
    const enc = encryptSecret(dek, plaintext, aad);
    expect(decryptSecret(dek, enc, aad)).toBe(plaintext);
  });

  test("round-trips a multiline value", () => {
    const plaintext = "-----BEGIN KEY-----\nline1\nline2\n-----END KEY-----\n";
    const enc = encryptSecret(dek, plaintext, aad);
    expect(decryptSecret(dek, enc, aad)).toBe(plaintext);
  });

  test("round-trips a 64KB value", () => {
    const plaintext = "x".repeat(64 * 1024);
    const enc = encryptSecret(dek, plaintext, aad);
    expect(enc.ct.length).toBe(64 * 1024);
    expect(decryptSecret(dek, enc, aad)).toBe(plaintext);
  });

  test("uses a 12-byte nonce and 16-byte tag", () => {
    const enc = encryptSecret(dek, "value", aad);
    expect(enc.nonce.length).toBe(12);
    expect(enc.tag.length).toBe(16);
  });

  test("same plaintext encrypted twice yields different nonce and ct", () => {
    const a = encryptSecret(dek, "same-value", aad);
    const b = encryptSecret(dek, "same-value", aad);
    expect(a.nonce.equals(b.nonce)).toBe(false);
    expect(a.ct.equals(b.ct)).toBe(false);
  });

  test("decrypt with flipped projectId in AAD throws DecryptError", () => {
    const enc = encryptSecret(dek, "value", aad);
    expect(() =>
      decryptSecret(dek, enc, { ...aad, projectId: "proj_2" }),
    ).toThrow(DecryptError);
  });

  test("decrypt with flipped envId in AAD throws DecryptError", () => {
    const enc = encryptSecret(dek, "value", aad);
    expect(() => decryptSecret(dek, enc, { ...aad, envId: "env_2" })).toThrow(
      DecryptError,
    );
  });

  test("decrypt with flipped secretKey in AAD throws DecryptError", () => {
    const enc = encryptSecret(dek, "value", aad);
    expect(() =>
      decryptSecret(dek, enc, { ...aad, secretKey: "OTHER_KEY" }),
    ).toThrow(DecryptError);
  });

  test("decrypt with a different DEK throws DecryptError", () => {
    const enc = encryptSecret(dek, "value", aad);
    expect(() => decryptSecret(generateDek(), enc, aad)).toThrow(DecryptError);
  });

  test("bit-flip in ct throws DecryptError", () => {
    const enc = encryptSecret(dek, "value", aad);
    expect(() =>
      decryptSecret(dek, { ...enc, ct: flipBit(enc.ct) }, aad),
    ).toThrow(DecryptError);
  });

  test("bit-flip in nonce throws DecryptError", () => {
    const enc = encryptSecret(dek, "value", aad);
    expect(() =>
      decryptSecret(dek, { ...enc, nonce: flipBit(enc.nonce) }, aad),
    ).toThrow(DecryptError);
  });

  test("bit-flip in tag throws DecryptError", () => {
    const enc = encryptSecret(dek, "value", aad);
    expect(() =>
      decryptSecret(dek, { ...enc, tag: flipBit(enc.tag) }, aad),
    ).toThrow(DecryptError);
  });
});
