import { describe, expect, test } from "bun:test";
import { GardensConfigError } from "./errors";
import { GARDENS_CONFIG_FILENAME, parseGardensConfig } from "./gardensConfig";

const VALID = {
  host: "https://gardens.example.com",
  project: "my-project",
  projectId: "proj_123",
  defaultEnvironment: "development",
};

describe("GARDENS_CONFIG_FILENAME", () => {
  test("is .gardens.json", () => {
    expect(GARDENS_CONFIG_FILENAME).toBe(".gardens.json");
  });
});

describe("parseGardensConfig", () => {
  test("parses a valid config", () => {
    expect(parseGardensConfig(JSON.stringify(VALID))).toEqual(VALID);
  });

  test("accepts an http host with port and path", () => {
    const config = { ...VALID, host: "http://localhost:8080" };
    expect(parseGardensConfig(JSON.stringify(config)).host).toBe(
      "http://localhost:8080",
    );
  });

  test("ignores unknown fields", () => {
    const config = { ...VALID, extra: "ignored", another: 42 };
    expect(parseGardensConfig(JSON.stringify(config))).toEqual(VALID);
  });

  test("throws GardensConfigError on invalid JSON", () => {
    expect(() => parseGardensConfig("{not json")).toThrow(GardensConfigError);
  });

  test("throws GardensConfigError when the root is not an object", () => {
    for (const json of ["42", "null", '"str"', "[]", "true"]) {
      expect(() => parseGardensConfig(json)).toThrow(GardensConfigError);
    }
  });

  describe("host", () => {
    test("missing host", () => {
      const { host: _host, ...rest } = VALID;
      expect(() => parseGardensConfig(JSON.stringify(rest))).toThrow(/host/);
      expect(() => parseGardensConfig(JSON.stringify(rest))).toThrow(
        GardensConfigError,
      );
    });

    test("non-string host", () => {
      expect(() =>
        parseGardensConfig(JSON.stringify({ ...VALID, host: 42 })),
      ).toThrow(/host/);
    });

    test("empty host", () => {
      expect(() =>
        parseGardensConfig(JSON.stringify({ ...VALID, host: "" })),
      ).toThrow(/host/);
    });

    test("non-URL host", () => {
      expect(() =>
        parseGardensConfig(JSON.stringify({ ...VALID, host: "not a url" })),
      ).toThrow(/host/);
    });

    test("non-http(s) scheme is rejected", () => {
      expect(() =>
        parseGardensConfig(
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
        expect(() => parseGardensConfig(JSON.stringify(config))).toThrow(
          GardensConfigError,
        );
        expect(() => parseGardensConfig(JSON.stringify(config))).toThrow(
          new RegExp(field),
        );
      });

      test(`empty ${field}`, () => {
        expect(() =>
          parseGardensConfig(JSON.stringify({ ...VALID, [field]: "" })),
        ).toThrow(new RegExp(field));
      });

      test(`non-string ${field}`, () => {
        expect(() =>
          parseGardensConfig(JSON.stringify({ ...VALID, [field]: 7 })),
        ).toThrow(new RegExp(field));
      });
    });
  }
});
