import { describe, expect, test } from "bun:test";
import { newId } from "./ids";

describe("newId", () => {
  test("produces prefix_32hex with no colons or dashes", () => {
    const id = newId("prj");
    expect(id).toMatch(/^prj_[0-9a-f]{32}$/);
    expect(id).not.toContain(":");
    expect(id).not.toContain("-");
  });

  test("is unique across calls", () => {
    const ids = new Set(Array.from({ length: 100 }, () => newId("env")));
    expect(ids.size).toBe(100);
  });

  test("rejects prefixes that could break AAD/key delimiting", () => {
    expect(() => newId("bad:prefix")).toThrow(/invalid id prefix/);
    expect(() => newId("")).toThrow(/invalid id prefix/);
    expect(() => newId("Has-Upper")).toThrow(/invalid id prefix/);
  });
});
