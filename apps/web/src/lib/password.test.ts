import { describe, expect, test } from "bun:test";
import { passwordStrength } from "./password";

describe("passwordStrength", () => {
  test("too short", () => {
    expect(passwordStrength("abc").score).toBe(0);
    expect(passwordStrength("1234567").score).toBe(0);
  });

  test("weak: short single-class", () => {
    expect(passwordStrength("aaaaaaaa").score).toBe(1);
  });

  test("fair: 12+ chars with two classes", () => {
    expect(passwordStrength("correcthorse1").score).toBe(2);
  });

  test("strong: 16+ chars with three classes", () => {
    expect(passwordStrength("Correct-Horse-Battery-9").score).toBe(3);
  });
});
