import { describe, expect, test } from "bun:test";
import { SafeConfigError } from "./errors";
import { parseSafeConfig, SAFE_CONFIG_FILENAME } from "./safeConfig";

const VALID = {
  host: "https://safe.example.com",
  project: "my-project",
  projectId: "proj_123",
  defaultEnvironment: "development",
};

describe("SAFE_CONFIG_FILENAME", () => {
  test("is .safe.json", () => {
    expect(SAFE_CONFIG_FILENAME).toBe(".safe.json");
  });
});

describe("parseSafeConfig", () => {
  test("parses a valid config", () => {
    expect(parseSafeConfig(JSON.stringify(VALID))).toEqual(VALID);
  });

  test("accepts an http host with port and path", () => {
    const config = { ...VALID, host: "http://localhost:8080" };
    expect(parseSafeConfig(JSON.stringify(config)).host).toBe(
      "http://localhost:8080",
    );
  });

  test("ignores unknown fields", () => {
    const config = { ...VALID, extra: "ignored", another: 42 };
    expect(parseSafeConfig(JSON.stringify(config))).toEqual(VALID);
  });

  test("throws SafeConfigError on invalid JSON", () => {
    expect(() => parseSafeConfig("{not json")).toThrow(SafeConfigError);
  });

  test("throws SafeConfigError when the root is not an object", () => {
    for (const json of ["42", "null", '"str"', "[]", "true"]) {
      expect(() => parseSafeConfig(json)).toThrow(SafeConfigError);
    }
  });

  describe("host", () => {
    test("missing host", () => {
      const { host: _host, ...rest } = VALID;
      expect(() => parseSafeConfig(JSON.stringify(rest))).toThrow(/host/);
      expect(() => parseSafeConfig(JSON.stringify(rest))).toThrow(
        SafeConfigError,
      );
    });

    test("non-string host", () => {
      expect(() =>
        parseSafeConfig(JSON.stringify({ ...VALID, host: 42 })),
      ).toThrow(/host/);
    });

    test("empty host", () => {
      expect(() =>
        parseSafeConfig(JSON.stringify({ ...VALID, host: "" })),
      ).toThrow(/host/);
    });

    test("non-URL host", () => {
      expect(() =>
        parseSafeConfig(JSON.stringify({ ...VALID, host: "not a url" })),
      ).toThrow(/host/);
    });

    test("non-http(s) scheme is rejected", () => {
      expect(() =>
        parseSafeConfig(
          JSON.stringify({ ...VALID, host: "ftp://example.com" }),
        ),
      ).toThrow(/host/);
    });
  });

  for (const field of ["project", "projectId", "defaultEnvironment"] as const) {
    describe(field, () => {
      test(`missing ${field}`, () => {
        const config: Record<string, unknown> = { ...VALID };
        delete config[field];
        expect(() => parseSafeConfig(JSON.stringify(config))).toThrow(
          SafeConfigError,
        );
        expect(() => parseSafeConfig(JSON.stringify(config))).toThrow(
          new RegExp(field),
        );
      });

      test(`empty ${field}`, () => {
        expect(() =>
          parseSafeConfig(JSON.stringify({ ...VALID, [field]: "" })),
        ).toThrow(new RegExp(field));
      });

      test(`non-string ${field}`, () => {
        expect(() =>
          parseSafeConfig(JSON.stringify({ ...VALID, [field]: 7 })),
        ).toThrow(new RegExp(field));
      });
    });
  }
});
