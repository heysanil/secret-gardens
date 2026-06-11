import { describe, expect, test } from "bun:test";
import { classifyToken, TOKEN_PREFIXES } from "./tokens";

describe("TOKEN_PREFIXES", () => {
  test("has the expected prefixes", () => {
    expect(TOKEN_PREFIXES).toEqual({
      serviceToken: "sg_st_",
      userToken: "sg_ut_",
    });
  });
});

describe("classifyToken", () => {
  test("classifies service tokens", () => {
    expect(classifyToken("sg_st_abc123")).toBe("service");
  });

  test("classifies user tokens", () => {
    expect(classifyToken("sg_ut_abc123")).toBe("user");
  });

  test("returns null for unknown prefixes", () => {
    expect(classifyToken("ghp_abc123")).toBe(null);
    expect(classifyToken("sg_xx_abc123")).toBe(null);
    expect(classifyToken("abc123")).toBe(null);
  });

  test("returns null for the empty string", () => {
    expect(classifyToken("")).toBe(null);
  });

  test("is case-sensitive", () => {
    expect(classifyToken("SG_ST_abc123")).toBe(null);
  });

  test("returns null for an incomplete prefix", () => {
    expect(classifyToken("sg_st")).toBe(null);
    expect(classifyToken("sg_ut")).toBe(null);
  });

  test("a bare prefix still classifies by prefix", () => {
    expect(classifyToken("sg_st_")).toBe("service");
    expect(classifyToken("sg_ut_")).toBe("user");
  });
});
