import { describe, expect, test } from "bun:test";
import { formatRelativeTime } from "./relativeTime";

const NOW = Date.UTC(2026, 5, 10, 12, 0, 0);

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("formatRelativeTime", () => {
  test("clamps small future skew to just now", () => {
    expect(formatRelativeTime(NOW + 20_000, NOW)).toBe("just now");
  });

  test("just now under 45s", () => {
    expect(formatRelativeTime(NOW - 10_000, NOW)).toBe("just now");
    expect(formatRelativeTime(NOW - 44_000, NOW)).toBe("just now");
  });

  test("singular minute around the boundary", () => {
    expect(formatRelativeTime(NOW - 60_000, NOW)).toBe("1m ago");
    expect(formatRelativeTime(NOW - 89_000, NOW)).toBe("1m ago");
  });

  test("minutes", () => {
    expect(formatRelativeTime(NOW - 5 * MINUTE, NOW)).toBe("5m ago");
    expect(formatRelativeTime(NOW - 59 * MINUTE, NOW)).toBe("59m ago");
  });

  test("hours", () => {
    expect(formatRelativeTime(NOW - HOUR, NOW)).toBe("1h ago");
    expect(formatRelativeTime(NOW - 23 * HOUR, NOW)).toBe("23h ago");
  });

  test("days", () => {
    expect(formatRelativeTime(NOW - DAY, NOW)).toBe("1d ago");
    expect(formatRelativeTime(NOW - 6 * DAY, NOW)).toBe("6d ago");
  });

  test("weeks", () => {
    expect(formatRelativeTime(NOW - 7 * DAY, NOW)).toBe("1w ago");
    expect(formatRelativeTime(NOW - 27 * DAY, NOW)).toBe("4w ago");
  });

  test("old timestamps fall back to a date", () => {
    const out = formatRelativeTime(NOW - 90 * DAY, NOW);
    expect(out).not.toContain("ago");
    expect(out).toContain("2026");
  });
});
