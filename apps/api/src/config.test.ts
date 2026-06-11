import { describe, expect, test } from "bun:test";
import { generateMasterKey } from "@safe/crypto";
import { ConfigError, loadConfig } from "./config";

const validKey = generateMasterKey();
const validSecret = "a".repeat(32);

/** Minimal valid env — tests spread this and override. */
const baseEnv = {
  SAFE_MASTER_KEY: validKey,
  BETTER_AUTH_SECRET: validSecret,
};

describe("loadConfig", () => {
  test("applies defaults when only required keys are set", () => {
    const config = loadConfig({ ...baseEnv });
    expect(config.port).toBe(3000);
    expect(config.redisUrl).toBe("redis://localhost:6379");
    expect(config.dbPath).toBe("./data/safe.db");
    expect(config.publicUrl).toBe("http://localhost:3000");
    expect(config.auditMaxLen).toBeNull();
    expect(config.masterKey.kekId).toMatch(/^[0-9a-f]{16}$/);
    expect(config.authSecret).toBe(validSecret);
    expect(config.github).toBeNull();
    expect(config.google).toBeNull();
    expect(config.additionalOrigins).toEqual([]);
    expect(config.webDistPath).toBeNull();
  });

  test("honors explicit values", () => {
    const config = loadConfig({
      ...baseEnv,
      PORT: "8080",
      REDIS_URL: "redis://redis:6379",
      SAFE_DB_PATH: "/data/safe.db",
      SAFE_PUBLIC_URL: "https://safe.example.com",
      SAFE_AUDIT_MAXLEN: "10000",
      SAFE_WEB_DIST: "/app/apps/web/dist",
    });
    expect(config.port).toBe(8080);
    expect(config.redisUrl).toBe("redis://redis:6379");
    expect(config.dbPath).toBe("/data/safe.db");
    expect(config.publicUrl).toBe("https://safe.example.com");
    expect(config.auditMaxLen).toBe(10000);
    expect(config.webDistPath).toBe("/app/apps/web/dist");
  });

  test("treats an empty SAFE_WEB_DIST as disabled", () => {
    const config = loadConfig({ ...baseEnv, SAFE_WEB_DIST: "" });
    expect(config.webDistPath).toBeNull();
  });

  describe("SAFE_MASTER_KEY validation", () => {
    const badKeys: Array<[string, string | undefined]> = [
      ["missing", undefined],
      ["empty", ""],
      ["not base64", "!!!not-base64!!!"],
      ["wrong length", Buffer.alloc(16).toString("base64")],
    ];

    for (const [label, value] of badKeys) {
      test(`rejects ${label} key with an actionable message`, () => {
        const env: Record<string, string | undefined> = {
          BETTER_AUTH_SECRET: validSecret,
        };
        if (value !== undefined) {
          env.SAFE_MASTER_KEY = value;
        }
        expect(() => loadConfig(env)).toThrow(ConfigError);
        try {
          loadConfig(env);
        } catch (err) {
          const message = (err as Error).message;
          expect(message).toContain("SAFE_MASTER_KEY");
          expect(message).toContain("scripts/setup.sh");
        }
      });
    }

    test("never echoes the provided key value in errors", () => {
      const secretLooking = "this-is-my-secret-key-value-do-not-echo";
      try {
        loadConfig({
          SAFE_MASTER_KEY: secretLooking,
          BETTER_AUTH_SECRET: validSecret,
        });
        expect.unreachable("should have thrown");
      } catch (err) {
        expect((err as Error).message).not.toContain(secretLooking);
      }
    });
  });

  describe("BETTER_AUTH_SECRET validation", () => {
    const badSecrets: Array<[string, string | undefined]> = [
      ["missing", undefined],
      ["empty", ""],
      ["too short (31 chars)", "x".repeat(31)],
    ];

    for (const [label, value] of badSecrets) {
      test(`rejects ${label} secret with an actionable message`, () => {
        const env: Record<string, string | undefined> = {
          SAFE_MASTER_KEY: validKey,
        };
        if (value !== undefined) {
          env.BETTER_AUTH_SECRET = value;
        }
        expect(() => loadConfig(env)).toThrow(ConfigError);
        try {
          loadConfig(env);
        } catch (err) {
          const message = (err as Error).message;
          expect(message).toContain("BETTER_AUTH_SECRET");
          expect(message).toContain("scripts/setup.sh");
        }
      });
    }

    test("accepts a secret of exactly 32 chars", () => {
      const config = loadConfig({
        ...baseEnv,
        BETTER_AUTH_SECRET: validSecret,
      });
      expect(config.authSecret).toBe(validSecret);
    });

    test("never echoes the provided secret value in errors", () => {
      const secretLooking = "short-but-still-a-secret-value";
      try {
        loadConfig({
          ...baseEnv,
          BETTER_AUTH_SECRET: secretLooking,
        });
        expect.unreachable("should have thrown");
      } catch (err) {
        expect((err as Error).message).not.toContain(secretLooking);
      }
    });
  });

  describe("OAuth provider credentials", () => {
    test("github pair is parsed when both halves are present", () => {
      const config = loadConfig({
        ...baseEnv,
        GITHUB_CLIENT_ID: "gh-id",
        GITHUB_CLIENT_SECRET: "gh-secret",
      });
      expect(config.github).toEqual({
        clientId: "gh-id",
        clientSecret: "gh-secret",
      });
      expect(config.google).toBeNull();
    });

    test("google pair is parsed when both halves are present", () => {
      const config = loadConfig({
        ...baseEnv,
        GOOGLE_CLIENT_ID: "g-id",
        GOOGLE_CLIENT_SECRET: "g-secret",
      });
      expect(config.google).toEqual({
        clientId: "g-id",
        clientSecret: "g-secret",
      });
      expect(config.github).toBeNull();
    });

    for (const [label, env] of [
      ["GITHUB_CLIENT_ID without secret", { GITHUB_CLIENT_ID: "gh-id" }],
      ["GITHUB_CLIENT_SECRET without id", { GITHUB_CLIENT_SECRET: "gh-sec" }],
      ["GOOGLE_CLIENT_ID without secret", { GOOGLE_CLIENT_ID: "g-id" }],
      ["GOOGLE_CLIENT_SECRET without id", { GOOGLE_CLIENT_SECRET: "g-sec" }],
    ] as const) {
      test(`rejects half-configured provider: ${label}`, () => {
        expect(() => loadConfig({ ...baseEnv, ...env })).toThrow(
          /must be configured together/,
        );
      });
    }
  });

  describe("SAFE_ADDITIONAL_ORIGINS validation", () => {
    test("absent → empty list", () => {
      expect(loadConfig({ ...baseEnv }).additionalOrigins).toEqual([]);
    });

    test("empty string → empty list", () => {
      expect(
        loadConfig({ ...baseEnv, SAFE_ADDITIONAL_ORIGINS: "" })
          .additionalOrigins,
      ).toEqual([]);
    });

    test("single origin", () => {
      expect(
        loadConfig({
          ...baseEnv,
          SAFE_ADDITIONAL_ORIGINS: "http://localhost:5173",
        }).additionalOrigins,
      ).toEqual(["http://localhost:5173"]);
    });

    test("multiple origins with whitespace are trimmed and normalized", () => {
      expect(
        loadConfig({
          ...baseEnv,
          SAFE_ADDITIONAL_ORIGINS:
            " http://localhost:5173 , https://app.example.com/ ",
        }).additionalOrigins,
      ).toEqual(["http://localhost:5173", "https://app.example.com"]);
    });

    for (const [label, value] of [
      ["a bare host", "localhost:5173"],
      ["a relative path", "/app"],
      ["garbage", "not a url"],
    ] as const) {
      test(`rejects ${label}`, () => {
        expect(() =>
          loadConfig({ ...baseEnv, SAFE_ADDITIONAL_ORIGINS: value }),
        ).toThrow(/SAFE_ADDITIONAL_ORIGINS/);
      });
    }

    test("rejects non-http(s) schemes", () => {
      expect(() =>
        loadConfig({
          ...baseEnv,
          SAFE_ADDITIONAL_ORIGINS: "ftp://example.com",
        }),
      ).toThrow(/http or https/);
    });
  });

  describe("SAFE_AUDIT_MAXLEN validation", () => {
    for (const bad of ["abc", "0", "-5", "1.5", "", "10x"]) {
      test(`rejects ${JSON.stringify(bad)}`, () => {
        expect(() =>
          loadConfig({ ...baseEnv, SAFE_AUDIT_MAXLEN: bad }),
        ).toThrow(/SAFE_AUDIT_MAXLEN must be a positive integer/);
      });
    }

    test("accepts a positive integer", () => {
      const config = loadConfig({
        ...baseEnv,
        SAFE_AUDIT_MAXLEN: "500",
      });
      expect(config.auditMaxLen).toBe(500);
    });
  });

  describe("PORT validation", () => {
    for (const bad of ["abc", "0", "-1", "3.5"]) {
      test(`rejects ${JSON.stringify(bad)}`, () => {
        expect(() => loadConfig({ ...baseEnv, PORT: bad })).toThrow(
          ConfigError,
        );
      });
    }

    test("rejects ports above 65535", () => {
      expect(() => loadConfig({ ...baseEnv, PORT: "70000" })).toThrow(
        /PORT must be at most 65535/,
      );
    });
  });
});
