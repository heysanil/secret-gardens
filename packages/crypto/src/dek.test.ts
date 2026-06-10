import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  DekUnwrapError,
  generateDek,
  generateMasterKey,
  KekMismatchError,
  loadMasterKey,
  MasterKeyError,
  unwrapDek,
  type WrappedDek,
  wrapDek,
} from "./index";

function flipBit(buf: Buffer, index = 0): Buffer {
  const copy = Buffer.from(buf);
  copy.writeUInt8(copy.readUInt8(index) ^ 0x01, index);
  return copy;
}

describe("generateDek", () => {
  test("returns 32 random bytes, distinct across calls", () => {
    const a = generateDek();
    const b = generateDek();
    expect(a.length).toBe(32);
    expect(b.length).toBe(32);
    expect(a.equals(b)).toBe(false);
  });
});

describe("wrapDek / unwrapDek", () => {
  const mk = loadMasterKey(generateMasterKey());
  const projectId = "proj_abc123";

  test("round-trip returns identical 32 bytes", () => {
    const dek = generateDek();
    const w = wrapDek(mk, dek, projectId);
    const unwrapped = unwrapDek(mk, w, projectId);
    expect(unwrapped.length).toBe(32);
    expect(unwrapped.equals(dek)).toBe(true);
  });

  test("wrapped DEK carries the master key kekId, 12-byte nonce, 16-byte tag", () => {
    const dek = generateDek();
    const w = wrapDek(mk, dek, projectId);
    expect(w.kekId).toBe(mk.kekId);
    expect(w.nonce.length).toBe(12);
    expect(w.tag.length).toBe(16);
    expect(w.wrapped.equals(dek)).toBe(false);
  });

  test("unwrap with a different MasterKey throws KekMismatchError", () => {
    const w = wrapDek(mk, generateDek(), projectId);
    const otherMk = loadMasterKey(generateMasterKey());
    expect(() => unwrapDek(otherMk, w, projectId)).toThrow(KekMismatchError);
  });

  test("KekMismatchError message mentions rotation and SAFE_MASTER_KEY", () => {
    const w = wrapDek(mk, generateDek(), projectId);
    const otherMk = loadMasterKey(generateMasterKey());
    let caught: unknown;
    try {
      unwrapDek(otherMk, w, projectId);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(KekMismatchError);
    expect((caught as Error).name).toBe("KekMismatchError");
    expect((caught as Error).message).toContain("SAFE_MASTER_KEY");
    expect((caught as Error).message.toLowerCase()).toContain("rotat");
  });

  test("kekId mismatch is detected before decryption is attempted", () => {
    // Fully corrupt ciphertext + tag: if decryption ran first we would see
    // DekUnwrapError; KekMismatchError proves the kekId check happens first.
    const w = wrapDek(mk, generateDek(), projectId);
    const corrupted: WrappedDek = {
      wrapped: randomBytes(32),
      nonce: w.nonce,
      tag: randomBytes(16),
      kekId: w.kekId,
    };
    const otherMk = loadMasterKey(generateMasterKey());
    expect(() => unwrapDek(otherMk, corrupted, projectId)).toThrow(
      KekMismatchError,
    );
  });

  test("two MasterKeys loaded from the same raw key interoperate", () => {
    const value = generateMasterKey();
    const mk1 = loadMasterKey(value);
    const mk2 = loadMasterKey(value);
    expect(mk1).not.toBe(mk2);
    expect(mk1.kekId).toBe(mk2.kekId);
    const dek = generateDek();
    const w = wrapDek(mk1, dek, projectId);
    expect(unwrapDek(mk2, w, projectId).equals(dek)).toBe(true);
  });

  test("tampered wrapped bytes throw DekUnwrapError", () => {
    const w = wrapDek(mk, generateDek(), projectId);
    const tampered = { ...w, wrapped: flipBit(w.wrapped) };
    expect(() => unwrapDek(mk, tampered, projectId)).toThrow(DekUnwrapError);
  });

  test("tampered nonce throws DekUnwrapError", () => {
    const w = wrapDek(mk, generateDek(), projectId);
    const tampered = { ...w, nonce: flipBit(w.nonce) };
    expect(() => unwrapDek(mk, tampered, projectId)).toThrow(DekUnwrapError);
  });

  test("tampered tag throws DekUnwrapError", () => {
    const w = wrapDek(mk, generateDek(), projectId);
    const tampered = { ...w, tag: flipBit(w.tag) };
    expect(() => unwrapDek(mk, tampered, projectId)).toThrow(DekUnwrapError);
  });

  test("wrong projectId AAD throws DekUnwrapError", () => {
    const w = wrapDek(mk, generateDek(), projectId);
    expect(() => unwrapDek(mk, w, "proj_other")).toThrow(DekUnwrapError);
  });

  test("wrapDek rejects a non-32-byte dek with MasterKeyError", () => {
    expect(() => wrapDek(mk, randomBytes(31), projectId)).toThrow(
      MasterKeyError,
    );
    expect(() => wrapDek(mk, randomBytes(33), projectId)).toThrow(
      MasterKeyError,
    );
    expect(() => wrapDek(mk, Buffer.alloc(0), projectId)).toThrow(
      MasterKeyError,
    );
  });
});
