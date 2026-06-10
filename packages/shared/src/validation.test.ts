import { describe, expect, test } from "bun:test";
import {
  MAX_BULK_SECRETS,
  MAX_SECRET_KEY_LENGTH,
  MAX_SECRET_VALUE_BYTES,
  SECRET_KEY_PATTERN,
  validateSecretKey,
  validateSecretValue,
} from "./validation";

describe("constants", () => {
  test("have the expected values", () => {
    expect(MAX_SECRET_KEY_LENGTH).toBe(256);
    expect(MAX_SECRET_VALUE_BYTES).toBe(65536);
    expect(MAX_BULK_SECRETS).toBe(1000);
  });

  test("SECRET_KEY_PATTERN matches identifier-style keys", () => {
    expect(SECRET_KEY_PATTERN.test("DATABASE_URL")).toBe(true);
    expect(SECRET_KEY_PATTERN.test("_private")).toBe(true);
    expect(SECRET_KEY_PATTERN.test("1KEY")).toBe(false);
    expect(SECRET_KEY_PATTERN.test("MY-KEY")).toBe(false);
  });
});

describe("validateSecretKey", () => {
  test("returns null for valid keys", () => {
    for (const key of ["A", "_x", "FOO_BAR2", "lower_case", "Mixed_Case_99"]) {
      expect(validateSecretKey(key)).toBeNull();
    }
  });

  test("accepts a key of exactly the max length", () => {
    expect(validateSecretKey("A".repeat(MAX_SECRET_KEY_LENGTH))).toBeNull();
  });

  test("rejects a key one over the max length with a reason", () => {
    const reason = validateSecretKey("A".repeat(MAX_SECRET_KEY_LENGTH + 1));
    expect(reason).toMatch(/256/);
  });

  test("rejects the empty string with a reason", () => {
    expect(validateSecretKey("")).toEqual(expect.any(String));
  });

  test("rejects keys violating the pattern with a reason", () => {
    for (const key of ["1KEY", "MY-KEY", "MY KEY", "foo.bar", "ÜBER", "key!"]) {
      expect(validateSecretKey(key)).toEqual(expect.any(String));
    }
  });
});

describe("validateSecretValue", () => {
  test("accepts the empty string", () => {
    expect(validateSecretValue("")).toBeNull();
  });

  test("accepts an ASCII value of exactly the byte cap", () => {
    expect(validateSecretValue("a".repeat(MAX_SECRET_VALUE_BYTES))).toBeNull();
  });

  test("rejects an ASCII value one byte over the cap with a reason", () => {
    const reason = validateSecretValue("a".repeat(MAX_SECRET_VALUE_BYTES + 1));
    expect(reason).toMatch(/65536/);
  });

  test("counts multi-byte UTF-8 characters by encoded size (3-byte euro)", () => {
    // "€" encodes to 3 bytes: 21845 × 3 = 65535.
    const justUnder = "€".repeat(21845);
    expect(validateSecretValue(justUnder)).toBeNull();
    expect(validateSecretValue(`${justUnder}a`)).toBeNull(); // exactly 65536
    expect(validateSecretValue(`${justUnder}aa`)).toEqual(expect.any(String)); // 65537
    expect(validateSecretValue(`${justUnder}€`)).toEqual(expect.any(String)); // 65538
  });

  test("counts 4-byte emoji by encoded size", () => {
    // "😀" encodes to 4 bytes: 16384 × 4 = 65536 exactly.
    const exact = "😀".repeat(16384);
    expect(validateSecretValue(exact)).toBeNull();
    expect(validateSecretValue(`${exact}a`)).toEqual(expect.any(String));
  });
});
