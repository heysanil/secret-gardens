import { describe, expect, test } from "bun:test";
import { createHash, hkdfSync, randomBytes } from "node:crypto";
import {
  CryptoError,
  generateMasterKey,
  loadMasterKey,
  MasterKeyError,
} from "./index";

describe("generateMasterKey", () => {
  test("produces standard base64 decoding to exactly 32 bytes", () => {
    const value = generateMasterKey();
    expect(value).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(Buffer.from(value, "base64").length).toBe(32);
  });

  test("produces distinct values across calls", () => {
    expect(generateMasterKey()).not.toBe(generateMasterKey());
  });
});

describe("loadMasterKey", () => {
  test("round-trips a generated master key", () => {
    const value = generateMasterKey();
    const mk = loadMasterKey(value);
    expect(mk.kekId).toMatch(/^[0-9a-f]{16}$/);
  });

  test("rejects undefined with MasterKeyError", () => {
    expect(() => loadMasterKey(undefined)).toThrow(MasterKeyError);
  });

  test("rejects empty string with MasterKeyError", () => {
    expect(() => loadMasterKey("")).toThrow(MasterKeyError);
  });

  test("rejects non-base64 input with MasterKeyError", () => {
    expect(() => loadMasterKey("not-base64!!!")).toThrow(MasterKeyError);
  });

  test("rejects base64 of 31 bytes with MasterKeyError", () => {
    const value = randomBytes(31).toString("base64");
    expect(() => loadMasterKey(value)).toThrow(MasterKeyError);
  });

  test("rejects base64 of 33 bytes with MasterKeyError", () => {
    const value = randomBytes(33).toString("base64");
    expect(() => loadMasterKey(value)).toThrow(MasterKeyError);
  });

  test("error messages never echo the input value", () => {
    const inputs = [
      "not-base64!!!",
      randomBytes(31).toString("base64"),
      randomBytes(33).toString("base64"),
    ];
    for (const input of inputs) {
      let caught: unknown;
      try {
        loadMasterKey(input);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(MasterKeyError);
      expect((caught as Error).message).not.toContain(input);
    }
  });

  test("MasterKeyError extends CryptoError with correct name", () => {
    let caught: unknown;
    try {
      loadMasterKey(undefined);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CryptoError);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).name).toBe("MasterKeyError");
  });
});

describe("kekId", () => {
  test("is the first 16 hex chars of sha256 of the raw key bytes", () => {
    const raw = randomBytes(32);
    const mk = loadMasterKey(raw.toString("base64"));
    const expected = createHash("sha256")
      .update(raw)
      .digest("hex")
      .slice(0, 16);
    expect(mk.kekId).toBe(expected);
    expect(mk.kekId).toMatch(/^[0-9a-f]{16}$/);
    expect(mk.kekId.length).toBe(16);
  });

  test("is deterministic for the same input", () => {
    const value = generateMasterKey();
    expect(loadMasterKey(value).kekId).toBe(loadMasterKey(value).kekId);
  });

  test("differs for different keys", () => {
    expect(loadMasterKey(generateMasterKey()).kekId).not.toBe(
      loadMasterKey(generateMasterKey()).kekId,
    );
  });
});

describe("MasterKey hygiene", () => {
  test("JSON.stringify exposes only kekId, never key material", () => {
    const raw = randomBytes(32);
    const mk = loadMasterKey(raw.toString("base64"));
    const json = JSON.stringify(mk);
    expect(JSON.parse(json)).toEqual({ kekId: mk.kekId });

    const wrappingKey = Buffer.from(
      hkdfSync(
        "sha256",
        raw,
        Buffer.alloc(0),
        "secret-gardens/v1/dek-wrap",
        32,
      ),
    );
    const forbidden = [
      raw.toString("hex"),
      raw.toString("base64"),
      wrappingKey.toString("hex"),
      wrappingKey.toString("base64"),
    ];
    for (const encoded of forbidden) {
      expect(json).not.toContain(encoded);
    }
  });

  test("Object.keys and Object.entries expose only kekId", () => {
    const mk = loadMasterKey(generateMasterKey());
    expect(Object.keys(mk)).toEqual(["kekId"]);
    expect(Object.entries(mk)).toEqual([["kekId", mk.kekId]]);
  });
});
