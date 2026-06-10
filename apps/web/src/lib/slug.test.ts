import { describe, expect, test } from "bun:test";
import { deriveProjectSlug, PROJECT_SLUG_RE } from "./slug";

describe("deriveProjectSlug", () => {
  test("lowercases and hyphenates", () => {
    expect(deriveProjectSlug("My App!")).toBe("my-app");
    expect(deriveProjectSlug("  Billing  Service  ")).toBe("billing-service");
  });

  test("collapses symbol runs", () => {
    expect(deriveProjectSlug("a---b___c")).toBe("a-b-c");
  });

  test("strips leading and trailing hyphens", () => {
    expect(deriveProjectSlug("---edge---")).toBe("edge");
  });

  test("all-symbol names produce empty string", () => {
    expect(deriveProjectSlug("!!!")).toBe("");
  });

  test("caps at 63 chars without a trailing hyphen", () => {
    const out = deriveProjectSlug(`${"a".repeat(62)} tail`);
    expect(out.length).toBeLessThanOrEqual(63);
    expect(out.endsWith("-")).toBe(false);
    expect(PROJECT_SLUG_RE.test(out)).toBe(true);
  });
});
