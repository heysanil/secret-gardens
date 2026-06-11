import { describe, expect, test } from "bun:test";
import { buildCallbackUrl, parseCliAuthParams } from "./cliAuth";

function params(record: Record<string, string>): URLSearchParams {
  return new URLSearchParams(record);
}

describe("parseCliAuthParams", () => {
  test("accepts a well-formed request", () => {
    const out = parseCliAuthParams(
      params({ redirect_port: "49152", state: "abc123", name: "mbp.local" }),
    );
    expect(out).toEqual({
      ok: true,
      request: { port: 49152, state: "abc123", name: "mbp.local" },
    });
  });

  test("rejects missing port", () => {
    const out = parseCliAuthParams(params({ state: "s" }));
    expect(out.ok).toBe(false);
  });

  test("rejects non-integer port", () => {
    expect(
      parseCliAuthParams(params({ redirect_port: "80a", state: "s" })).ok,
    ).toBe(false);
    expect(
      parseCliAuthParams(params({ redirect_port: "12.5", state: "s" })).ok,
    ).toBe(false);
  });

  test("rejects ports outside 1024-65535", () => {
    expect(
      parseCliAuthParams(params({ redirect_port: "80", state: "s" })).ok,
    ).toBe(false);
    expect(
      parseCliAuthParams(params({ redirect_port: "65536", state: "s" })).ok,
    ).toBe(false);
    expect(
      parseCliAuthParams(params({ redirect_port: "1024", state: "s" })).ok,
    ).toBe(true);
    expect(
      parseCliAuthParams(params({ redirect_port: "65535", state: "s" })).ok,
    ).toBe(true);
  });

  test("rejects empty state", () => {
    expect(
      parseCliAuthParams(params({ redirect_port: "5000", state: "" })).ok,
    ).toBe(false);
    expect(parseCliAuthParams(params({ redirect_port: "5000" })).ok).toBe(
      false,
    );
  });

  test("missing name falls back to a display placeholder", () => {
    const out = parseCliAuthParams(
      params({ redirect_port: "5000", state: "s" }),
    );
    expect(out.ok && out.request.name).toBe("unknown device");
  });
});

describe("buildCallbackUrl", () => {
  test("matches the fixed CLI contract exactly", () => {
    const url = buildCallbackUrl(49152, {
      token: "sg_ut_secret",
      tokenId: "ut_1",
      state: "xyz",
    });
    expect(url).toBe(
      "http://127.0.0.1:49152/callback?token=sg_ut_secret&tokenId=ut_1&state=xyz",
    );
  });

  test("url-encodes parameter values", () => {
    const url = buildCallbackUrl(5000, {
      token: "a+b/c=",
      tokenId: "id",
      state: "s &t",
    });
    const parsed = new URL(url);
    expect(parsed.searchParams.get("token")).toBe("a+b/c=");
    expect(parsed.searchParams.get("state")).toBe("s &t");
  });
});
